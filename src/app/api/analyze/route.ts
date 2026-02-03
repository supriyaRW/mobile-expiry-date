import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

type AnalyzeResponse = {
  product: string;
  expiryDate: string; // YYYY-MM-DD or ""
};

function coerceIsoDate(text: string): string {
  const normalized = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const m1 = normalized.match(/(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/);
  if (m1) {
    const [, d, m, y] = m1;
    return `${y}-${m}-${d}`;
  }
  const m2 = normalized.match(/(\d{4})[\/\-.](\d{2})[\/\-.](\d{2})/);
  if (m2) {
    const [, y, m, d] = m2;
    return `${y}-${m}-${d}`;
  }
  const m3 = normalized.match(/^(\d{4})[\/\-](\d{2})$/);
  if (m3) return `${m3[1]}-${m3[2]}-01`;
  return normalized;
}

const GEMINI_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

function getGeminiMimeType(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (GEMINI_IMAGE_TYPES.includes(t as (typeof GEMINI_IMAGE_TYPES)[number])) return t;
  return "image/jpeg";
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("image");
    const manualProduct = form.get("manualProduct");
    const manualDate = form.get("manualDate");
    if (!(file instanceof File)) {
      return Response.json({ error: "image required" }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");
    const mimeType = getGeminiMimeType(file);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0.2 },
    });

    const prompt = `You are a product label reader. Read ALL text visible in the image and extract:

1) product: The product name FROM THE TEXT in the image.
- Prefer the value of labeled fields such as: "Product Description", "QR Item Description", "Item Description", "Product Name", "Product:", "Description:" (use the value after the colon).
- Examples from such fields: "TOILET SEAT SANITIZING WIPES", "Refreshing Towel EY", "SHARPS CONTAINER 10L, 20 PCS PER BOX", "100% Natural Hair Remover", "CAFÉ NAJJAR RAQWA".
- If there is no such field, use the main product name or title clearly visible on the label (brand + product as written). Do NOT use LOT, REF, batch, or barcode codes as the product name.
- If the image only shows dates/lot/REF (e.g. LOT 20240715, REF LM240720, P: 11/2024, E: 10/2029) with no product description, return an empty string for product.

2) expiryDate: The expiry / best before / use-by date FROM THE TEXT in the image only. Return in YYYY-MM-DD format.
- Look for labels like: "Expiry Date", "Exp:", "E:", "Use by", "Best before", "EXPIRY DATE", hourglass symbol with date, etc.
- Accept dates in any format (DD.MM.YYYY, YYYY/MM, MM-YYYY, DD/MM/YYYY, "June 2029", "Jul-2027") and convert to YYYY-MM-DD. If month-only (e.g. 2027/01), use first day of that month (2027-01-01).
- If none or unreadable, return an empty string. Do NOT use manufacture/production date (P:, Prod., Production Date) as expiry.

Reply with ONLY a single-line JSON object, no markdown. Example:
{"product":"SHARPS CONTAINER 10L","expiryDate":"2027-01-01"}`;

    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [
          { text: prompt },
          { inlineData: { data: base64, mimeType } },
        ]},
      ],
    });

    let rawText: string;
    try {
      rawText = result.response.text() ?? "";
    } catch {
      rawText = "";
    }
    let extracted: AnalyzeResponse = { product: "", expiryDate: "" };
    const jsonStart = rawText.indexOf("{");
    const jsonEnd = rawText.lastIndexOf("}");
    const raw = jsonStart >= 0 && jsonEnd >= 0 ? rawText.slice(jsonStart, jsonEnd + 1) : rawText;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      extracted.product = String(parsed.product ?? "").trim().slice(0, 120);
      const rawExpiry = parsed.expiryDate ?? parsed.expiry ?? parsed.date ?? "";
      if (rawExpiry) extracted.expiryDate = coerceIsoDate(String(rawExpiry));
    } catch {
      const p = rawText.match(/"product"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (p) extracted.product = p[1].replace(/\\"/g, '"');
      const e = rawText.match(/"expiryDate"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (e) extracted.expiryDate = coerceIsoDate(e[1].replace(/\\"/g, '"'));
    }

    const manual = typeof manualProduct === "string" ? manualProduct.trim() : "";
    if (manual && !/^product_\d+$/.test(manual)) {
      extracted.product = manual.slice(0, 120);
    }
    if (typeof manualDate === "string" && manualDate.trim()) {
      extracted.expiryDate = coerceIsoDate(manualDate);
    }

    return Response.json(extracted satisfies AnalyzeResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("/api/analyze error", message);
    return Response.json({ error: "analysis_failed", message: String(message) }, { status: 500 });
  }
}


