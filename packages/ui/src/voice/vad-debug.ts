/**
 * Dev/QA VAD decision logging (voice VAD-tunability lane, on top of V2a #15417).
 * Prefix: `[eliza][vad]`. OFF by default — gated behind `ELIZA_VOICE_VAD_DEBUG`.
 *
 * WHY: the owner tunes end-of-speech VAD on real devices, where a cutoff that
 * misfires (clips a slow speaker, or ends too late) is invisible from the UI. A
 * QA build can flip this flag to see, per turn, exactly WHY a cutoff fired —
 * speech-start/speech-end timestamps, which threshold triggered the end-of-turn,
 * and whether the auto-send guard passed/why-not. This is the on-device evidence
 * that turns "the VAD feels off" into a specific tunable to change in
 * `vad-params.ts`.
 *
 * Mirrors the `tts-debug.ts` enable pattern exactly:
 * - **Node / API:** `ELIZA_VOICE_VAD_DEBUG=1` (or `true`/`yes`/`on`).
 * - **Renderer:** same env mirrored via Vite `define` (dev only).
 *
 * Never pass secrets in `detail`. With the flag on, transcript previews may
 * appear in the console — a dev/QA affordance, not for production/shared logs.
 */

type RuntimeImportMeta = ImportMeta & {
  env?: Record<string, unknown>;
};

function truthy(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function vadDebugEnabled(): boolean {
  if (typeof process !== "undefined" && process.env) {
    if (truthy(process.env.ELIZA_VOICE_VAD_DEBUG)) return true;
  }
  try {
    const viteEnv = (import.meta as RuntimeImportMeta).env;
    if (truthy(String(viteEnv?.ELIZA_VOICE_VAD_DEBUG ?? ""))) return true;
    if (truthy(String(viteEnv?.VITE_ELIZA_VOICE_VAD_DEBUG ?? ""))) return true;
  } catch (err) {
    // error-policy:J6 import.meta is unavailable in some runtimes (CJS test
    // environments); treat as "flag not set" rather than crashing the logger.
    void err;
  }
  return false;
}

/** Same predicate as {@link vadDebug}; use to skip building expensive detail. */
export function isVadDebugEnabled(): boolean {
  return vadDebugEnabled();
}

/**
 * A structured VAD decision record. Every field is optional so a call site logs
 * only what it knows (the capture loop knows thresholds/timestamps; the auto-
 * send path knows the guard result).
 */
export interface VadDecisionDetail {
  /** Discriminator: `speech-start` | `speech-end` | `auto-stop` | `auto-send`. */
  event: "speech-start" | "speech-end" | "auto-stop" | "auto-send";
  /** UI monotonic timestamp (performance.now) of the decision. */
  atMs?: number;
  /** Detected-speech duration accumulated in the turn so far (ms). */
  speechMs?: number;
  /** Trailing-silence measured at the cutoff (ms). */
  silenceMs?: number;
  /** Which threshold/rule triggered the cutoff (e.g. "silenceMs", "maxSpeechMs"). */
  trigger?: string;
  /** Frame energy at the decision (rms/peak) for gate debugging. */
  rms?: number;
  peak?: number;
  /** Whether the TTS echo gate was active (raised thresholds). */
  echoGated?: boolean;
  /** Auto-send guard outcome, when this is an `auto-send` decision. */
  guardOk?: boolean;
  guardReason?: string;
  /** Short transcript preview (dev only — may contain user speech). */
  transcriptPreview?: string;
}

/**
 * Emit one VAD decision line when `ELIZA_VOICE_VAD_DEBUG` is on; a no-op
 * otherwise (zero cost past the flag check). Callers should still avoid building
 * costly detail unless {@link isVadDebugEnabled} is true.
 */
export function vadDebug(detail: VadDecisionDetail): void {
  if (!vadDebugEnabled()) return;
  console.info(`[eliza][vad] ${detail.event}`, detail);
}
