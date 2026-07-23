/// <reference types="vite/client" />

/**
 * Server-side TTS pipeline tracing (opt-in). Prefix: `[eliza][tts]`.
 * Never pass secrets in `detail`. With debug on, `preview` fields may contain
 * user-visible spoken text — disable in shared logs / production.
 *
 * `ttsDebug` emits straight through the structured logger at `info` level, so
 * setting the env flag is sufficient on every server host (bare agent server,
 * app-core API, packaged desktop) — no per-host wiring exists to forget
 * (#16347). Info level is deliberate: the operator opted in explicitly, so the
 * lines must be visible at the default `LOG_LEVEL` rather than hiding behind
 * `debug`.
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
import { logger } from "@elizaos/core";

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
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars)}…`;
}

/**
 * Emit one TTS trace line through the structured logger when
 * `ELIZA_TTS_DEBUG` is set; a no-op otherwise.
 */
export function ttsDebug(
  phase: string,
  detail?: Record<string, unknown>,
): void {
  if (!ttsDebugEnabled()) return;
  if (detail && Object.keys(detail).length > 0) {
    logger.info(detail, `[eliza][tts] ${phase}`);
  } else {
    logger.info(`[eliza][tts] ${phase}`);
  }
}
