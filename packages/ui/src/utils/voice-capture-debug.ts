/**
 * Voice-capture lifecycle tracing (opt-in). Prefix: `[eliza][voice-capture]`.
 *
 * Purpose: make the next "tapped the mic, then crickets" report diagnosable
 * from the device console in seconds. Each breadcrumb marks one step of the
 * capture lifecycle so a silent no-op is legible instead of invisible:
 *
 *   `start:cloud` / `start:local-inference` — a WAV recorder began.
 *   `pause:cancel` — an APP_PAUSE discarded an in-flight capture.
 *   `pause:kept` — an APP_PAUSE fired inside the permission-prompt grace window
 *                  and the young capture was KEPT (the iOS getUserMedia dialog
 *                  steals focus → visibilitychange → this must not cancel).
 *   `silent:drop` — the pre-POST silence guard no-op'd a near-silent WAV
 *                   (crickets BY DESIGN — the UI now surfaces a subtle hint).
 *   `posted` — a WAV was POSTed to the STT proxy.
 *   `transcript` — a final transcript was emitted.
 *
 * Zero-cost when disabled: the predicate short-circuits before any string work.
 *
 * Enable with:
 * - **Renderer (WebView / installed PWA):** `localStorage.setItem("eliza:voice:debug", "1")`
 *   then reload — the fastest path on a physical device (Safari Web Inspector or
 *   the installed-PWA remote console), no rebuild needed.
 * - **Build-time:** `ELIZA_VOICE_DEBUG=1` (mirrored via Vite `define`), same as
 *   the sibling TTS debug flag.
 */
type RuntimeImportMeta = ImportMeta & {
  env?: Record<string, unknown>;
};

function truthy(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function voiceDebugEnabled(): boolean {
  // localStorage first: it's the on-device toggle that needs no rebuild — set
  // it in the console on the physical iPhone and reload to capture the next tap.
  try {
    if (
      typeof localStorage !== "undefined" &&
      truthy(localStorage.getItem("eliza:voice:debug"))
    ) {
      return true;
    }
  } catch {
    /* localStorage blocked (sandbox / private mode) — fall through */
  }

  if (typeof process !== "undefined" && process.env) {
    if (truthy(process.env.ELIZA_VOICE_DEBUG)) return true;
  }

  try {
    const viteEnv = (import.meta as RuntimeImportMeta).env;
    if (truthy(String(viteEnv?.ELIZA_VOICE_DEBUG ?? ""))) return true;
    if (truthy(String(viteEnv?.VITE_ELIZA_VOICE_DEBUG ?? ""))) return true;
  } catch {
    /* no import.meta */
  }

  return false;
}

// ── On-screen breadcrumb ring (device HUD) ───────────────────────────
//
// The console breadcrumbs above are invisible on an installed iPhone PWA (no
// devtools). We won the viewport-geometry war with an on-screen diagnostics
// chip (BuildBadge); do the same for voice: mirror every breadcrumb into a
// tiny ring buffer that a bottom-anchored HUD renders, so the NEXT device
// screenshot shows exactly where a "tapped the mic, then crickets" capture
// dies — `mic:tap → gum:req → gum:ok → ctx:running → rec:start → …` or the
// exact failing step (`gum:err`, `ctx:suspended!`, `wav:SILENT`, `post:403`)
// or NOTHING AT ALL after `mic:tap` (= the click handler never reached
// capture).
//
// The ring is ALWAYS populated (independent of the console-debug predicate)
// so the HUD works on a stamped sol-dev build without the tester first
// setting `localStorage['eliza:voice:debug']`. It's a fixed-size in-memory
// buffer — zero network, zero storage, negligible cost.

/** One recorded breadcrumb: step label, wall-clock ms, and sanitized detail. */
export interface VoiceCaptureBreadcrumb {
  /** Monotonic sequence id (for stable React keys + ordering). */
  seq: number;
  /** The lifecycle step, e.g. `mic:tap`, `gum:ok`, `post:200`. */
  step: string;
  /** `performance.now()` (ms) when recorded — HUD renders offsets from `mic:tap`. */
  atMs: number;
  /** Optional structured detail (no secrets), compacted for the HUD line. */
  detail?: Record<string, unknown>;
}

/** How many breadcrumbs the HUD keeps. The mandate asks for "last ~8". */
export const VOICE_HUD_RING_SIZE = 12;

const breadcrumbRing: VoiceCaptureBreadcrumb[] = [];
let breadcrumbSeq = 0;
type BreadcrumbListener = (ring: readonly VoiceCaptureBreadcrumb[]) => void;
const breadcrumbListeners = new Set<BreadcrumbListener>();

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Subscribe to breadcrumb-ring updates (the HUD's data source). The listener
 * fires on every push with the current ring snapshot; returns an unsubscribe.
 * Immediately invoked once so a late-mounting HUD paints the existing trace.
 */
export function subscribeVoiceCaptureBreadcrumbs(
  listener: BreadcrumbListener,
): () => void {
  breadcrumbListeners.add(listener);
  listener(breadcrumbRing.slice());
  return () => {
    breadcrumbListeners.delete(listener);
  };
}

/** Current ring snapshot (oldest → newest). */
export function getVoiceCaptureBreadcrumbs(): readonly VoiceCaptureBreadcrumb[] {
  return breadcrumbRing.slice();
}

/** Clear the ring (e.g. a fresh `mic:tap` starts a clean trace). */
export function resetVoiceCaptureBreadcrumbs(): void {
  breadcrumbRing.length = 0;
  const snapshot = breadcrumbRing.slice();
  for (const l of breadcrumbListeners) l(snapshot);
}

function pushBreadcrumb(step: string, detail?: Record<string, unknown>): void {
  breadcrumbSeq += 1;
  breadcrumbRing.push({
    seq: breadcrumbSeq,
    step,
    atMs: nowMs(),
    detail: detail && Object.keys(detail).length > 0 ? detail : undefined,
  });
  // Trim to the ring size (drop oldest).
  while (breadcrumbRing.length > VOICE_HUD_RING_SIZE) breadcrumbRing.shift();
  const snapshot = breadcrumbRing.slice();
  for (const l of breadcrumbListeners) l(snapshot);
}

/**
 * One lifecycle-step breadcrumb. No secrets in `detail`.
 *
 * Dual sink: always mirrors into the on-screen HUD ring (device-visible), and
 * ALSO logs to the console when the debug predicate is enabled (desktop /
 * remote-inspector convenience). The HUD ring is unconditional so a stamped
 * sol-dev build is diagnosable on-device with no console toggle.
 */
export function voiceCaptureDebug(
  step: string,
  detail?: Record<string, unknown>,
): void {
  // A new tap begins a fresh trace so the HUD isn't cluttered with the previous
  // (successful or dead) attempt — the last 8 events should describe THIS tap.
  if (step === "mic:tap") resetVoiceCaptureBreadcrumbs();
  pushBreadcrumb(step, detail);
  if (!voiceDebugEnabled()) return;
  if (detail && Object.keys(detail).length > 0) {
    console.info(`[eliza][voice-capture] ${step}`, detail);
  } else {
    console.info(`[eliza][voice-capture] ${step}`);
  }
}
