/**
 * Renderer side of the Android agent-triggered screen-capture bridge: pull-polls
 * queued capture requests and POSTs frames back, since Android has no
 * agent→renderer push channel. See the block below for the full protocol.
 */
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

/**
 * Once this many polls fail in a row, stop hammering the route every 1500ms and
 * back off exponentially. The common cause is a `404` — the vision plugin isn't
 * loaded in this config (e.g. on-device inference with no vision), so
 * `/api/vision/capture-requests` is unregistered and every 1500ms poll 404s
 * forever, burning CPU/network/battery and spamming logs. A single success snaps
 * the interval back to fast, so a vision backend that comes online later still
 * recovers. (#10724)
 */
const BACKOFF_AFTER_FAILURES = 5;
const MAX_BACKOFF_MS = 60_000;

/**
 * Poll delay (ms) for the current consecutive-failure streak: the fast interval
 * until the streak crosses {@link BACKOFF_AFTER_FAILURES}, then exponential
 * backoff capped at {@link MAX_BACKOFF_MS}. Pure — unit-tested without timers.
 */
export function computePollDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures < BACKOFF_AFTER_FAILURES) return POLL_INTERVAL_MS;
  const over = consecutiveFailures - BACKOFF_AFTER_FAILURES + 1;
  return Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** over);
}

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
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

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
    if (!res.ok) {
      // 404 = the vision route isn't registered in this config; other non-ok is
      // transient. Either way, count toward backoff so we don't spin at 1500ms.
      consecutiveFailures += 1;
      return;
    }
    consecutiveFailures = 0;
    const data = (await res.json()) as { requests?: unknown };
    const list = Array.isArray(data.requests) ? data.requests : [];
    requests = list.filter(isCaptureRequest);
  } catch {
    // Agent not reachable yet (early boot) — count, next tick retries fast.
    consecutiveFailures += 1;
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
function scheduleNextPoll(delayMs: number): void {
  pollTimer = setTimeout(() => {
    void poll().finally(() => {
      // Re-arm from the current failure streak so a persistently-404 route backs
      // off instead of polling forever; a success resets the streak to fast.
      if (started) scheduleNextPoll(computePollDelayMs(consecutiveFailures));
    });
  }, delayMs);
}

export function initScreenCaptureBridge(): void {
  if (started) return;
  if (!isNativeMobile()) return;
  started = true;
  consecutiveFailures = 0;
  scheduleNextPoll(POLL_INTERVAL_MS);
}

/** Test-only reset hook. */
export function __resetScreenCaptureBridgeForTests(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  started = false;
  consecutiveFailures = 0;
}
