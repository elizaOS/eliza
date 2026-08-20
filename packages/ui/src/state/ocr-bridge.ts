/**
 * Polls native OCR requests from the renderer and returns Tesseract recognition
 * results. The lifecycle is pull-based because native platforms have no push
 * channel into this renderer surface.
 */
import { Capacitor } from "@capacitor/core";
import { getTesseractPlugin } from "../bridge/native-plugins";

const POLL_INTERVAL_MS = 1200;
const OCR_FETCH_TIMEOUT_MS = 15_000;

interface OcrRequest {
  requestId: string;
  createdAt: number;
  imageBase64: string;
  psm?: number;
}

let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let bridgeController: AbortController | null = null;
let callerSignal: AbortSignal | null = null;
let abortFromCaller: (() => void) | null = null;
let activePoll: Promise<void> | null = null;

function stopPolling(reason?: unknown): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  bridgeController?.abort(
    reason ?? new DOMException("OCR bridge stopped", "AbortError"),
  );
  bridgeController = null;
  if (callerSignal && abortFromCaller) {
    callerSignal.removeEventListener("abort", abortFromCaller);
  }
  callerSignal = null;
  abortFromCaller = null;
  activePoll = null;
  started = false;
}

async function withFetchDeadline<T>(
  signal: AbortSignal,
  operation: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("OCR request timed out", "TimeoutError"));
  }, OCR_FETCH_TIMEOUT_MS);

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function isNativeMobile(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return platform === "android" || platform === "ios";
  } catch {
    // error-policy:J4 capability probe — no Capacitor runtime means no native
    // OCR on this platform; the bridge simply stays off.
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

async function fetchOcrRequests(signal: AbortSignal): Promise<OcrRequest[]> {
  return withFetchDeadline(signal, async (requestSignal) => {
    const response = await fetch("/api/vision/ocr-requests", {
      method: "GET",
      signal: requestSignal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { requests?: unknown };
    const list = Array.isArray(data.requests) ? data.requests : [];
    return list.filter(isOcrRequest);
  });
}

async function postOcrResult(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  await withFetchDeadline(signal, async (requestSignal) => {
    const response = await fetch("/api/vision/ocr-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`OCR result request failed (${response.status})`);
    }
    await response.arrayBuffer();
  });
}

async function serveRequest(
  request: OcrRequest,
  signal: AbortSignal,
): Promise<void> {
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
    signal.throwIfAborted();
    await postOcrResult(
      {
        requestId: request.requestId,
        words: result.words,
      },
      signal,
    );
  } catch (error) {
    if (signal.aborted) return;
    const reason = error instanceof Error ? error.message : String(error);
    // error-policy:J5 best-effort failure report — if even the error POST
    // fails, the agent still observes the failure via its own OCR request
    // timeout; the poller must keep running for the next request.
    await postOcrResult(
      { requestId: request.requestId, error: reason },
      signal,
    ).catch(() => {});
  }
}

async function poll(signal: AbortSignal): Promise<void> {
  let requests: OcrRequest[];
  try {
    requests = await fetchOcrRequests(signal);
  } catch {
    // error-policy:J4 agent not reachable yet (early boot) — the next
    // interval tick retries; pending requests time out on the agent side.
    return;
  }

  for (const request of requests) {
    if (signal.aborted) return;
    await serveRequest(request, signal);
  }
}

export function initOcrBridge(signal?: AbortSignal): () => void {
  if (started || signal?.aborted || !isNativeMobile()) return () => {};
  started = true;
  const controller = new AbortController();
  bridgeController = controller;
  if (signal) {
    callerSignal = signal;
    abortFromCaller = () => stopPolling(signal.reason);
    signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  pollTimer = setInterval(() => {
    if (activePoll) return;
    const currentPoll = poll(controller.signal).finally(() => {
      if (activePoll === currentPoll) activePoll = null;
    });
    activePoll = currentPoll;
  }, POLL_INTERVAL_MS);

  return () => {
    if (bridgeController === controller) stopPolling();
  };
}
