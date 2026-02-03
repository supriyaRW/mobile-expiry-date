import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

type SessionImage = {
  id: string;
  dataUrl: string;
  product?: string;
  expiryDate?: string;
};

type SessionState = {
  mobileConnected: boolean;
  webConnected: boolean;
  command: string | null;
  images: SessionImage[];
};

const sessions = new Map<string, SessionState>();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
};

function bufferToDataUrl(buffer: Buffer, mime: string): string {
  const base64 = buffer.toString("base64");
  return `data:${mime || "image/jpeg"};base64,${base64}`;
}

function getOrCreate(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      mobileConnected: false,
      webConnected: false,
      command: null,
      images: [],
    });
  }
  return sessions.get(sessionId)!;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400, headers: corsHeaders });
  const state = getOrCreate(sessionId);
  return NextResponse.json(state, { headers: corsHeaders });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400, headers: corsHeaders });
  const state = getOrCreate(sessionId);
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const file = form.get("image");
      if (file instanceof File && file.size > 0) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const mime = file.type || "image/jpeg";
        state.images.push({
          id: `mobile-${Date.now()}-${state.images.length}`,
          dataUrl: bufferToDataUrl(buffer, mime),
          product: "",
          expiryDate: "",
        });
      }
    } catch {
      // ignore
    }
    return NextResponse.json(state, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    if (typeof body.mobileConnected === "boolean") state.mobileConnected = body.mobileConnected;
    if (typeof body.webConnected === "boolean") state.webConnected = body.webConnected;
    if (body.command !== undefined) state.command = body.command === null ? null : String(body.command);
    if (typeof body.image === "string" && body.image.length > 0) {
      state.images.push({
        id: `mobile-${Date.now()}-${state.images.length}`,
        dataUrl: body.image,
        product: "",
        expiryDate: "",
      });
    }
  } catch {
    // ignore invalid JSON
  }
  return NextResponse.json(state, { headers: corsHeaders });
}
