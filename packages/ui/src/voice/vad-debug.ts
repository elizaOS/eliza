/**
 * VAD / end-of-speech decision tracing (opt-in). Prefix: `[eliza][vad]`.
 *
 * Owner ask (2026-07-07, voice V2a): "if cheap, expose a debug/QA affordance
 * (e.g. dev-flag logging of VAD decisions: speech-start / speech-end timestamps
 * + why) so device testing can tell us WHY a cutoff mis-fired." This is that
 * affordance — a zero-cost-when-off logger for the auto-stop + auto-send
 * decisions so on-device QA can see the reason a turn ended (or an auto-send was
 * suppressed) instead of guessing.
 *
 * Enable with `ELIZA_VAD_DEBUG=1` (Node) or the Vite-mirrored env in the
 * renderer (same mechanism as ELIZA_TTS_DEBUG). Off by default — no logging,
 * no allocation on the audio hot path (the gate short-circuits before building
 * the detail object).
 *
 * NOTE: with debug ON, `transcriptPreview` fields may contain user-visible
 * spoken text. Disable in shared logs / production.
 */

type RuntimeImportMeta = ImportMeta & {
  env?: Record<string, unknown>;
};

function truthy(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

let cachedEnabled: boolean | null = null;

function vadDebugEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  let enabled = false;
  if (typeof process !== "undefined" && process.env) {
    if (truthy(process.env.ELIZA_VAD_DEBUG)) enabled = true;
  }
  if (!enabled) {
    try {
      const viteEnv = (import.meta as RuntimeImportMeta).env;
      if (
        truthy(String(viteEnv?.ELIZA_VAD_DEBUG ?? "")) ||
        truthy(String(viteEnv?.VITE_ELIZA_VAD_DEBUG ?? ""))
      ) {
        enabled = true;
      }
    } catch {
      /* no import.meta */
    }
  }
  cachedEnabled = enabled;
  return enabled;
}

/** Same predicate — use to guard building an expensive detail object. */
export function isVadDebugEnabled(): boolean {
  return vadDebugEnabled();
}

/** VAD lifecycle events surfaced for QA. */
export type VadDebugEvent =
  | "speech-start"
  | "speech-end"
  | "auto-stop"
  | "auto-send"
  | "auto-send-suppressed";

/**
 * Log one VAD decision. No-op (and no allocation cost past the arg you pass)
 * when `ELIZA_VAD_DEBUG` is off. Keep `detail` small + secret-free.
 */
export function vadDebug(
  event: VadDebugEvent,
  detail?: Record<string, unknown>,
): void {
  if (!vadDebugEnabled()) return;
  const line = `[eliza][vad] ${event}`;
  if (detail) {
    // eslint-disable-next-line no-console
    console.debug(line, detail);
  } else {
    // eslint-disable-next-line no-console
    console.debug(line);
  }
}

/** Reset the cached enable flag (tests toggle the env between cases). */
export function __resetVadDebugCacheForTests(): void {
  cachedEnabled = null;
}
