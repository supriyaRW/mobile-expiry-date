"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";

type UploadedImage = {
  id: string;
  file: File;
  url: string;
  product: string;
  expiryDate: string; // YYYY-MM-DD
  status: "Valid" | "Expiring Soon" | "Expired";
};

function computeStatus(dateISO: string): UploadedImage["status"] {
  if (!dateISO.trim()) return "Valid";
  const today = new Date();
  const target = new Date(dateISO);
  if (isNaN(target.getTime())) return "Valid";
  const diffDays = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "Expired";
  if (diffDays <= 30) return "Expiring Soon";
  return "Valid";
}

function HomeContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get("session") ?? null;

  const [images, setImages] = useState<UploadedImage[]>([]);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const [mobileConnected, setMobileConnected] = useState(false);
  const seenImageIdsRef = useRef<Set<string>>(new Set());
  const imagesLengthRef = useRef(0);

  useEffect(() => {
    seenImageIdsRef.current = new Set(images.map((i) => i.id));
    imagesLengthRef.current = images.length;
  }, [images]);

  const sessionApiHeaders: HeadersInit = useMemo(
    () => ({
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    }),
    []
  );

  useEffect(() => {
    if (!sessionId) return;
    const base = typeof window !== "undefined" ? window.location.origin : "";
    void fetch(`${base}/api/session/${sessionId}`, {
      method: "POST",
      headers: sessionApiHeaders,
      body: JSON.stringify({ webConnected: true }),
    });
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${base}/api/session/${sessionId}`, {
          headers: { "ngrok-skip-browser-warning": "true" },
        });
        const data = (await res.json()) as {
          mobileConnected?: boolean;
          images?: Array<{ id: string; dataUrl: string; product?: string; expiryDate?: string }>;
        };
        if (data.mobileConnected) setMobileConnected(true);
        const apiImages = data.images ?? [];
        const newApiImages = apiImages.filter((img) => !seenImageIdsRef.current.has(img.id));
        if (newApiImages.length === 0) return;
        const baseIndex = imagesLengthRef.current;
        const converted: UploadedImage[] = await Promise.all(
          newApiImages.map(async (apiImg, idx) => {
            const resImg = await fetch(apiImg.dataUrl);
            const blob = await resImg.blob();
            const file = new File([blob], "mobile.jpg", { type: blob.type || "image/jpeg" });
            const url = URL.createObjectURL(file);
            return {
              id: apiImg.id,
              file,
              url,
              product: `product_${baseIndex + idx + 1}`,
              expiryDate: "",
              status: "Valid" as const,
            };
          })
        );
        setImages((prev) => [...prev, ...converted]);
        converted.forEach((item) => seenImageIdsRef.current.add(item.id));
        imagesLengthRef.current += converted.length;
        analyzeBatch(converted);
      } catch {
        // ignore
      }
    }, 2000);
    return () => {
      clearInterval(interval);
      void fetch(`${base}/api/session/${sessionId}`, {
        method: "POST",
        headers: sessionApiHeaders,
        body: JSON.stringify({ webConnected: false }),
      });
      setMobileConnected(false);
    };
  }, [sessionId, sessionApiHeaders]);

  const openCameraOnPhone = useCallback(() => {
    if (!sessionId) return;
    const base = typeof window !== "undefined" ? window.location.origin : "";
    void fetch(`${base}/api/session/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({ command: "open_camera" }),
    });
  }, [sessionId]);

  const onFilesSelected = useCallback((filesList: FileList | null) => {
    if (!filesList) return;
    // Limit each upload action to 10 files, but allow multiple uploads overall
    const incoming = Array.from(filesList).slice(0, 10);
    const base = images.length;
    const nextItems: UploadedImage[] = incoming.map((file, idx) => {
      const url = URL.createObjectURL(file);
      const placeholderName = `product_${base + idx + 1}`;
      return {
        id: `${Date.now()}-${idx}`,
        file,
        url,
        product: placeholderName,
        expiryDate: "",
        status: "Valid" as const,
      };
    });
    setImages((prev) => [...prev, ...nextItems]);
    // Analyze newly added images
    void analyzeBatch(nextItems);
  }, [images.length]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    onFilesSelected(e.dataTransfer.files);
  }, [onFilesSelected]);

  const handleBrowse = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return images;
    return images.filter((img) =>
      img.product.toLowerCase().includes(term) || img.expiryDate.includes(term)
    );
  }, [images, search]);

  const counts = useMemo(() => ({
    total: images.length,
    expiring: images.filter((i) => i.status === "Expiring Soon").length,
    valid: images.filter((i) => i.status === "Valid").length,
    expired: images.filter((i) => i.status === "Expired").length,
  }), [images]);

  const downloadCSV = useCallback(() => {
    const headers = ["Image", "Product", "Expiry Date", "Status"];
    const rows = images.map((i) => [i.file.name, i.product, i.expiryDate, i.status]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "expiry-results.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [images]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const toRemove = prev.find((i) => i.id === id);
      if (toRemove) {
        try { URL.revokeObjectURL(toRemove.url); } catch {}
      }
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  async function analyzeBatch(batch: UploadedImage[]) {
    setIsAnalyzing(true);
    try {
      const updates = await Promise.all(batch.map(async (item) => {
        const form = new FormData();
        form.append("image", item.file);
        const isPlaceholder = /^product_\d+$/.test((item.product || "").trim());
        if (item.product && !isPlaceholder) form.append("manualProduct", item.product);
        if (item.expiryDate) form.append("manualDate", item.expiryDate);
        const res = await fetch("/api/analyze", { method: "POST", body: form });
        const data = await res.json() as { product?: string; expiryDate?: string; error?: string };
        if (!res.ok) {
          return { id: item.id, product: "—", expiryDate: item.expiryDate, status: "Valid" as const };
        }
        const name = data.product && String(data.product).trim().length > 0 ? String(data.product).trim() : "—";
        const expiry = typeof data.expiryDate === "string" ? data.expiryDate.trim() : "";
        return { id: item.id, product: name, expiryDate: expiry, status: computeStatus(expiry) };
      }));

      setImages((prev) => prev.map((img) => {
        const u = updates.find((x) => x && x.id === img.id);
        return u ? { ...img, product: u.product, expiryDate: u.expiryDate, status: u.status } : img;
      }));
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <div className="min-h-screen w-full soft-gradient bg-fixed p-6 sm:p-10">
      <div className="mx-auto max-w-7xl rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl p-6 sm:p-10 text-white shadow-2xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl sm:text-2xl font-semibold">Expiry Date Analyzer</h1>
          {!sessionId ? (
            <div className="rounded-lg border border-white/25 bg-white/10 backdrop-blur px-4 py-2 text-sm text-white/90">
              Connect your phone: open the mobile app, copy the link, then paste it in this browser (e.g. <span className="font-mono text-white">...?session=xxx</span>).
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className={`text-sm ${mobileConnected ? "text-green-300" : "text-white/70"}`}>
                {mobileConnected ? "Connected to phone" : "Connecting…"}
              </span>
              <button
                type="button"
                onClick={openCameraOnPhone}
                disabled={!mobileConnected}
                className="rounded-md bg-emerald-500/80 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Open camera on phone
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col md:flex-row gap-8">
          {/* Left Panel - 35% */}
          <section className="md:w-[35%] w-full">
            <h2 className="text-2xl font-semibold mb-4">Upload</h2>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="rounded-xl border border-white/25 bg-white/10 backdrop-blur-lg p-6 text-center shadow-lg"
            >
              <div className="h-48 grid place-items-center rounded-lg border border-dashed border-white/30 bg-white/5">
                <p className="max-w-[18rem] text-white/90">Drag and drop images here</p>
              </div>
              <div className="mt-5">
                <button
                  type="button"
                  onClick={handleBrowse}
                  className="mx-auto inline-flex h-10 items-center justify-center rounded-md bg-white/20 text-white px-5 font-medium shadow hover:bg-white/30 backdrop-blur"
                >
                  Browse
                </button>
                <p className="mt-2 text-sm text-white/80">Up to 10 images</p>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => onFilesSelected(e.target.files)}
              />
            </div>

            {images.length > 0 && (
              <div className="mt-6 flex flex-wrap gap-4 overflow-y-auto no-scrollbar styled-scrollbar md:max-h-[68vh] pr-1">
                {images.map((img) => (
                  <div key={img.id} className="relative size-24 overflow-hidden rounded-lg border border-white/20 bg-white/10 backdrop-blur">
                    <button
                      type="button"
                      aria-label="Remove image"
                      onClick={() => removeImage(img.id)}
                      className="absolute left-1 top-1 z-10 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
                    >
                      {/* Trash icon */}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9 3H15M4 7H20M18 7L17.2 19.2C17.08 20.86 15.72 22 14.05 22H9.95C8.28 22 6.92 20.86 6.8 19.2L6 7M10 11V18M14 11V18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.url} alt={img.product} className="h-full w-full object-cover" />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Right Panel - 65% */}
          <section className="md:w-[65%] w-full">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-2xl font-semibold">Results</h2>
              <div className="text-sm text-white/85">
                {counts.total} images — {counts.expiring} expiring soon, {counts.valid} valid{counts.expired ? `, ${counts.expired} expired` : ""}
              </div>
            </div>
            <div className="rounded-xl border border-white/20 bg-white/10 backdrop-blur-lg p-4 sm:p-6 flex flex-col md:h-[72vh] shadow-lg">
              <div className="mb-4 flex items-center justify-between gap-3 shrink-0">
                <div className="relative w-60 max-w-full">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search"
                    className="w-full rounded-md border border-white/20 bg-white/10 px-9 py-2 placeholder-white/70 outline-none focus:ring-2 focus:ring-white/30 backdrop-blur"
                  />
                  <span className="absolute left-3 top-2.5 text-white/80">🔍</span>
                </div>
                <button
                  onClick={downloadCSV}
                  className="rounded-md bg-white/20 text-white px-4 py-2 text-sm font-medium shadow hover:bg-white/30 backdrop-blur"
                >
                  Download CSV
                </button>
                {isAnalyzing && (
                  <span className="ml-3 text-xs text-white/80">Analyzing...</span>
                )}
              </div>
              <div className="overflow-x-auto overflow-y-auto no-scrollbar styled-scrollbar flex-1">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-white/80">
                      <th className="py-2 pr-4 font-medium">Image</th>
                      <th className="py-2 pr-4 font-medium">Product</th>
                      <th className="py-2 pr-4 font-medium">Expiry Date</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((img) => (
                      <tr key={img.id} className="border-t border-white/10">
                        <td className="py-3 pr-4 align-middle">
                          <div className="size-12 overflow-hidden rounded-md border border-white/20 bg-white/10 backdrop-blur">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.url} alt={img.product} className="h-full w-full object-cover" />
                          </div>
                        </td>
                        <td className="py-3 pr-4 align-middle max-w-[12rem]">
                          <div className="text-white/95">{img.product || "—"}</div>
                        </td>
                        <td className="py-3 pr-4 align-middle">
                          <div className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-white/90 backdrop-blur">
                            {img.expiryDate || "—"}
                          </div>
                        </td>
                        <td className="py-3 pr-4 align-middle">
                          <span
                            className={
                              img.status === "Valid"
                                ? "inline-flex items-center rounded-full bg-green-500/20 px-3 py-1 text-xs font-semibold text-green-200"
                                : img.status === "Expiring Soon"
                                  ? "inline-flex items-center rounded-full bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-200"
                                  : "inline-flex items-center rounded-full bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-200"
                            }
                          >
                            {img.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr>
                        <td className="py-6 text-white/70" colSpan={4}>No items yet. Upload images to see results.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
      <div className="mx-auto max-w-7xl mt-6 text-center text-xs text-white/80">
        Powered by Randomwalk.ai
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen w-full soft-gradient bg-fixed p-6 flex items-center justify-center text-white/80">Loading…</div>}>
      <HomeContent />
    </Suspense>
  );
}
