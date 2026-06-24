import { Capacitor } from "@capacitor/core";
import { getScreenCapturePlugin } from "../bridge/native-plugins";

/**
 * Renderer side of the Android agent-triggered screen-capture bridge (#9105).
 *
 * On Android the agent (musl bun) has no Capacitor and there is no
 * agent->renderer push channel, so capture is renderer-PULLED: this module
 * interval-polls `GET /api/vision/capture-requests` (routed to the agent by the
 * installed Android fetch bridge), and for each queued request captures a frame
 * via the Capacitor ScreenCapture plugin (MediaProjection) and POSTs the PNG
 * back to `POST /api/vision/screen-frame`. A short interval (not long-poll)
 * keeps the agent's 30s capture timeout decoupled from the 10s JNI
 * fetch-timeout.
 */

const POLL_INTERVAL_MS = 1500;

interface CaptureRequest {
  requestId: string;
  createdAt: number;
  displayId?: number;
}

let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function isNativeMobile(): boolean {
  try {
    const platform = Capacitor.getPlatform();
    return platform === "android" || platform === "ios";
  } catch {
    return false;
  }
}

function isCaptureRequest(value: unknown): value is CaptureRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { requestId?: unknown }).requestId === "string"
  );
}

async function postScreenFrame(body: Record<string, unknown>): Promise<void> {
  await fetch("/api/vision/screen-frame", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function serveRequest(request: CaptureRequest): Promise<void> {
  try {
    const shot = await getScreenCapturePlugin().captureScreenshot({
      format: "png",
    });
    await postScreenFrame({
      requestId: request.requestId,
      base64: shot.base64,
      format: shot.format,
      width: shot.width,
      height: shot.height,
    });
  } catch (error) {
    // Report the failure so the agent's pending request settles immediately
    // (as null) instead of waiting out its timeout, and so this poller keeps
    // running for the next request.
    const reason = error instanceof Error ? error.message : String(error);
    await postScreenFrame({
      requestId: request.requestId,
      error: reason,
    }).catch(() => {});
  }
}

async function poll(): Promise<void> {
  let requests: CaptureRequest[];
  try {
    const res = await fetch("/api/vision/capture-requests");
    if (!res.ok) return;
    const data = (await res.json()) as { requests?: unknown };
    const list = Array.isArray(data.requests) ? data.requests : [];
    requests = list.filter(isCaptureRequest);
  } catch {
    // Agent not reachable yet (early boot) — next tick retries.
    return;
  }
  for (const request of requests) {
    await serveRequest(request);
  }
}

/**
 * Idempotent boot: start the capture-request poller on Android/iOS native.
 * No-op on web/desktop and on repeat calls.
 */
export function initScreenCaptureBridge(): void {
  if (started) return;
  if (!isNativeMobile()) return;
  started = true;
  pollTimer = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
}

/** Test-only reset hook. */
export function __resetScreenCaptureBridgeForTests(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  started = false;
}
