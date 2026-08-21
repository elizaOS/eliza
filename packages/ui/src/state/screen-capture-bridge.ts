/**
 * Renderer side of the Android agent-triggered screen-capture bridge: pull-polls
 * queued capture requests and POSTs frames back, since Android has no
 * agent→renderer push channel. See the block below for the full protocol.
 */
import { Capacitor } from "@capacitor/core";
import { getScreenCapturePlugin } from "../bridge/native-plugins";
import { fetchWithDeadline } from "../utils/fetch-with-deadline";

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

const SCREEN_CAPTURE_HOP_TIMEOUT_MS = 15_000;

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
let pollGeneration = 0;
let activePollController: AbortController | null = null;

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
    // error-policy:J3 an exotic host global shape reads as "not native".
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

async function postScreenFrame(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  await fetchWithDeadline(
    "/api/vision/screen-frame",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    async (response) => {
      if (!response.ok) {
        throw new Error(`Screen-frame request failed (${response.status})`);
      }
    },
    { signal, timeoutMs: SCREEN_CAPTURE_HOP_TIMEOUT_MS },
  );
}

async function serveRequest(
  request: CaptureRequest,
  signal: AbortSignal,
): Promise<void> {
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
    await postScreenFrame(
      {
        requestId: request.requestId,
        base64: shot.base64,
        format: shot.format,
        width: shot.width,
        height: shot.height,
      },
      signal,
    );
  } catch (error) {
    // Report the failure so the agent's pending request settles immediately
    // (as null) instead of waiting out its timeout, and so this poller keeps
    // running for the next request.
    const reason = error instanceof Error ? error.message : String(error);
    // error-policy:J5 best-effort failure report — if even the error POST
    // fails, the agent still observes the failure via its own 30s capture
    // timeout; the poller must keep running for the next request.
    await postScreenFrame(
      {
        requestId: request.requestId,
        error: reason,
      },
      signal,
    ).catch(() => undefined);
  }
}

async function poll(signal: AbortSignal): Promise<void> {
  let requests: CaptureRequest[];
  try {
    requests = await fetchWithDeadline(
      "/api/vision/capture-requests",
      { method: "GET" },
      async (response) => {
        if (!response.ok) {
          throw new Error(`Capture-request poll failed (${response.status})`);
        }
        const data = (await response.json()) as { requests?: unknown };
        const list = Array.isArray(data.requests) ? data.requests : [];
        return list.filter(isCaptureRequest);
      },
      { signal, timeoutMs: SCREEN_CAPTURE_HOP_TIMEOUT_MS },
    );
    consecutiveFailures = 0;
  } catch {
    if (signal.aborted) return;
    // error-policy:J4 agent not reachable yet (early boot) — count toward the
    // designed exponential backoff; the next tick retries.
    consecutiveFailures += 1;
    return;
  }
  for (const request of requests) {
    if (signal.aborted) return;
    await serveRequest(request, signal);
  }
}

/**
 * Idempotent boot: start the capture-request poller on Android/iOS native.
 * No-op on web/desktop and on repeat calls.
 */
function scheduleNextPoll(delayMs: number, generation: number): void {
  pollTimer = setTimeout(() => {
    const controller = new AbortController();
    activePollController = controller;
    void poll(controller.signal).finally(() => {
      if (activePollController === controller) activePollController = null;
      // Re-arm from the current failure streak so a persistently-404 route backs
      // off instead of polling forever; a success resets the streak to fast.
      if (started && generation === pollGeneration) {
        scheduleNextPoll(computePollDelayMs(consecutiveFailures), generation);
      }
    });
  }, delayMs);
}

export function initScreenCaptureBridge(): void {
  if (started) return;
  if (!isNativeMobile()) return;
  started = true;
  consecutiveFailures = 0;
  pollGeneration += 1;
  scheduleNextPoll(POLL_INTERVAL_MS, pollGeneration);
}

/** Test-only reset hook. */
export function __resetScreenCaptureBridgeForTests(): void {
  pollGeneration += 1;
  activePollController?.abort(
    new DOMException("Screen-capture poll stopped", "AbortError"),
  );
  activePollController = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  started = false;
  consecutiveFailures = 0;
}
