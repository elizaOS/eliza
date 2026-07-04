/**
 * Renderer side of the native OCR bridge: interval-polls the Tesseract
 * Capacitor plugin for queued OCR requests and returns recognized text. Mirrors
 * the pull-based pattern of screen-capture-bridge for platforms with no push
 * channel to the renderer.
 */
import { Capacitor } from "@capacitor/core";
import { getTesseractPlugin } from "../bridge/native-plugins";

const POLL_INTERVAL_MS = 1200;

interface OcrRequest {
  requestId: string;
  createdAt: number;
  imageBase64: string;
  psm?: number;
}

let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  started = false;
}

function isNativeMobile(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return platform === "android" || platform === "ios";
  } catch {
    return false;
  }
}

function isOcrRequest(value: unknown): value is OcrRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { requestId?: unknown }).requestId === "string" &&
    typeof (value as { imageBase64?: unknown }).imageBase64 === "string"
  );
}

async function postOcrResult(body: Record<string, unknown>): Promise<void> {
  await fetch("/api/vision/ocr-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function serveRequest(request: OcrRequest): Promise<void> {
  try {
    const opts: { image: string; psm?: number } = {
      image: request.imageBase64,
    };
    if (typeof request.psm === "number") opts.psm = request.psm;
    const plugin = getTesseractPlugin();
    if (typeof plugin.recognize !== "function") {
      throw new Error("native OCR plugin unavailable");
    }
    const result = await plugin.recognize(opts);
    await postOcrResult({
      requestId: request.requestId,
      words: result.words,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await postOcrResult({ requestId: request.requestId, error: reason }).catch(
      () => {},
    );
  }
}

async function poll(): Promise<void> {
  let requests: OcrRequest[];
  try {
    const res = await fetch("/api/vision/ocr-requests");
    if (!res.ok) return;
    const data = (await res.json()) as { requests?: unknown };
    const list = Array.isArray(data.requests) ? data.requests : [];
    requests = list.filter(isOcrRequest);
  } catch {
    return;
  }

  for (const request of requests) {
    await serveRequest(request);
  }
}

export function initOcrBridge(): void {
  if (started) return;
  if (!isNativeMobile()) return;
  started = true;
  pollTimer = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
}

export function __resetOcrBridgeForTests(): void {
  stopPolling();
}
