/**
 * Renderer side of the native OCR bridge: interval-polls the Tesseract
 * Capacitor plugin for queued OCR requests and returns recognized text. Mirrors
 * the pull-based pattern of screen-capture-bridge for platforms with no push
 * channel to the renderer.
 */
import { Capacitor } from "@capacitor/core";
import { client } from "../api";
import { getTesseractPlugin } from "../bridge/native-plugins";

const POLL_INTERVAL_MS = 1200;

/** Independent UI hops — same 15s family as screen-capture, separate deadlines. */
export const OCR_REQUESTS_POLL_TIMEOUT_MS = 15_000;
export const OCR_RESULT_POST_TIMEOUT_MS = 15_000;

interface OcrApiClient {
  fetch<T>(
    path: string,
    init?: RequestInit,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

interface OcrRequestsResponse {
  requests?: unknown;
}

export async function getOcrRequestsWithClient(
  apiClient: OcrApiClient,
  timeoutMs: number = OCR_REQUESTS_POLL_TIMEOUT_MS,
): Promise<OcrRequestsResponse> {
  return apiClient.fetch<OcrRequestsResponse>(
    "/api/vision/ocr-requests",
    undefined,
    { timeoutMs },
  );
}

export async function postOcrResultWithClient(
  body: Record<string, unknown>,
  apiClient: OcrApiClient,
  timeoutMs: number = OCR_RESULT_POST_TIMEOUT_MS,
): Promise<void> {
  await apiClient.fetch<{ ok: boolean }>(
    "/api/vision/ocr-result",
    { method: "POST", body: JSON.stringify(body) },
    { timeoutMs },
  );
}

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

async function postOcrResult(body: Record<string, unknown>): Promise<void> {
  await postOcrResultWithClient(body, client);
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
    // error-policy:J5 best-effort failure report — if even the error POST
    // fails, the agent still observes the failure via its own OCR request
    // timeout; the poller must keep running for the next request.
    await postOcrResult({ requestId: request.requestId, error: reason }).catch(
      () => {},
    );
  }
}

async function poll(): Promise<void> {
  let requests: OcrRequest[];
  try {
    const data = await getOcrRequestsWithClient(client);
    const list = Array.isArray(data.requests) ? data.requests : [];
    requests = list.filter(isOcrRequest);
  } catch {
    // error-policy:J4 agent not reachable yet (early boot) — the next
    // interval tick retries; pending requests time out on the agent side.
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
