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
  /** Optional agent-requested downscale (0–1 of native resolution). */
  scale?: number;
  /** Optional agent-requested JPEG quality (1–100). */
  quality?: number;
}

let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Frugal screen-understanding defaults: half-res, q70 → tens of KB per frame. */
function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 0.5;
  return Math.min(1, Math.max(0.1, scale));
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 70;
  return Math.min(100, Math.max(1, Math.round(quality)));
}

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
    // Capture as a scaled JPEG so the resize + encode happen NATIVELY (the
    // VirtualDisplay renders at the target resolution and Skia compresses) —
    // the agent never resizes or re-encodes pixels in JS. A ~half-res q70 JPEG
    // of a phone screen is tens of KB (vs a multi-MB full PNG), which is what
    // the IMAGE_DESCRIPTION (on-device GPU) describe path wants. Honour an
    // optional per-request maxScale/quality from the agent, else use frugal
    // defaults tuned for screen understanding + battery/latency.
    const scale = clampScale(request.scale ?? 0.5);
    const quality = clampQuality(request.quality ?? 70);
    const shot = await getScreenCapturePlugin().captureScreenshot({
      format: "jpeg",
      quality,
      scale,
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
