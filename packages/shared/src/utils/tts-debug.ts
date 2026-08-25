/// <reference types="vite/client" />

/**
 * Server-side TTS pipeline tracing (opt-in). Prefix: `[eliza][tts]`.
 * Never pass secrets in `detail`. With debug on, `preview` fields may contain
 * user-visible spoken text — disable in shared logs / production.
 *
 * `ttsDebug` emits straight through the structured logger, so setting the env
 * flag is sufficient on every server host (bare agent server, app-core API,
 * packaged desktop) — no per-host wiring exists to forget (#16347). The
 * emission level is `info` normally, but escalates to match the logger's
 * active threshold (`warn`/`error`/`fatal`) when `LOG_LEVEL` is stricter:
 * the operator opted in explicitly, so the diagnostic must never be silently
 * dead under any `LOG_LEVEL` — a below-threshold sink is the exact defect
 * #16347 existed to kill (#16958).
 *
 * Server phases: `server:cloud-tts:*` (Eliza Cloud proxy, includes optional
 * `messageId`, `clipSegment`, `hearingFull` when the client sends
 * `x-elizaos-tts-*` headers on `/api/tts/cloud`) and `server:local-tts:*`
 * (on-device synthesis via `/api/tts/local-inference`).
 *
 * Enable with:
 * - **Node / API:** `ELIZA_TTS_DEBUG=1` (or `true`, `yes`, `on`) — lines appear
 *   in the API terminal / `[api]` aggregator.
 * - **Renderer (WebView / browser):** the renderer flavor lives in
 *   `packages/ui/src/utils/tts-debug.ts` and logs to the JavaScript console;
 *   the same env is mirrored via Vite `define` in `apps/app/vite.config.ts`.
 */
import { logger, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

function ttsDebugEnabled(): boolean {
  const truthy = (raw: string | undefined | null): boolean => {
    if (raw == null) return false;
    const v = String(raw).trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  };

  if (typeof process !== "undefined" && process.env) {
    if (truthy(process.env.ELIZA_TTS_DEBUG)) return true;
  }

  try {
    // Use static `import.meta.env.*` so Vite `define` can replace ELIZA_TTS_DEBUG at build time.
    if (truthy(String(import.meta.env.ELIZA_TTS_DEBUG ?? ""))) return true;
    if (truthy(String(import.meta.env.VITE_ELIZA_TTS_DEBUG ?? ""))) return true;
  } catch {
    /* no import.meta */
  }

  return false;
}

/** Same predicate as `ttsDebug` — use to attach optional debug headers / task metadata. */
export function isTtsDebugEnabled(): boolean {
  return ttsDebugEnabled();
}

const DEFAULT_PREVIEW_MAX = 160;

/**
 * Single-line preview of text for TTS debug logs (avoids huge console lines).
 * Enable `ELIZA_TTS_DEBUG` only when you accept that spoken lines may appear in logs.
 */
export function ttsDebugTextPreview(
  text: string,
  maxChars: number = DEFAULT_PREVIEW_MAX,
): string {
  const singleLine = text.replace(/\r?\n/g, "↵ ").replace(/\s+/g, " ").trim();
  const wellFormed = toWellFormedUnicode(singleLine);
  if (wellFormed.length <= maxChars) return wellFormed;
  return `${truncateWellFormed(wellFormed, maxChars)}…`;
}

// The logger drops entries below its LOG_LEVEL threshold, so an opted-in
// diagnostic pinned at `info` is silently dead under LOG_LEVEL=warn/error.
// Emit at the lowest level the active threshold still lets through: info by
// default, escalating only as far as the configuration forces (#16958).
function ttsEmit(): (typeof logger)["info"] {
  const level = String(logger.level ?? "info")
    .trim()
    .toLowerCase();
  if (level === "fatal" || level === "alert") return logger.fatal.bind(logger);
  if (level === "error") return logger.error.bind(logger);
  if (level === "warn") return logger.warn.bind(logger);
  return logger.info.bind(logger);
}

/**
 * Emit one TTS trace line through the structured logger when
 * `ELIZA_TTS_DEBUG` is set; a no-op otherwise. Emission is guaranteed at any
 * `LOG_LEVEL`: the line rides at `info` normally and escalates to the active
 * threshold when the logger is configured stricter.
 */
export function ttsDebug(
  phase: string,
  detail?: Record<string, unknown>,
): void {
  if (!ttsDebugEnabled()) return;
  const emit = ttsEmit();
  if (detail && Object.keys(detail).length > 0) {
    emit(detail, `[eliza][tts] ${phase}`);
  } else {
    emit(`[eliza][tts] ${phase}`);
  }
}
