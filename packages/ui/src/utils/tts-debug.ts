/**
 * TTS pipeline tracing (opt-in). Prefix: `[eliza][tts]`.
 * Never pass secrets in `detail`. With debug on, `preview` fields may contain
 * user-visible spoken text — disable in shared logs / production.
 *
 * Playback phases (browser console): `play:web-audio:start|end` (ElevenLabs /
 * cloud MP3), `speakBrowser:enter`, `play:browser:web-speech:enqueued`,
 * `play:browser:speechSynthesis:start|end|error`, `play:talkmode:dispatch|speak-failed`,
 * `play:browser:no-synth`. Server logs: `server:cloud-tts:*` (includes optional
 * `messageId`, `clipSegment`, `hearingFull` when the client sends
 * `x-elizaos-tts-*` headers on `/api/tts/cloud`), ChatView: `chat:*`.
 *
 * Enable with:
 * - **Node / API:** `ELIZA_TTS_DEBUG=1` (or `true`, `yes`, `on`) — logs appear in the API
 *   terminal / `[api]` aggregator only for **server** routes (e.g. `server:cloud-tts:*`).
 * - **Renderer (WebView / browser):** same env is mirrored via Vite `define` in
 *   `apps/app/vite.config.ts` when you start dev with `ELIZA_TTS_DEBUG=1`. Those lines
 *   go to the **renderer** JavaScript console (Electrobun: Web Inspector on the window),
 *   not `LOG_LEVEL` on the API process alone.
 */
type RuntimeImportMeta = ImportMeta & {
  env?: Record<string, unknown>;
};

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
    const viteEnv = (import.meta as RuntimeImportMeta).env;
    if (truthy(String(viteEnv?.ELIZA_TTS_DEBUG ?? ""))) return true;
    if (truthy(String(viteEnv?.VITE_ELIZA_TTS_DEBUG ?? ""))) return true;
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

export function ttsDebug(
  phase: string,
  detail?: Record<string, unknown>,
): void {
  if (!ttsDebugEnabled()) return;
  if (detail && Object.keys(detail).length > 0) {
    console.info(`[eliza][tts] ${phase}`, detail);
  } else {
    console.info(`[eliza][tts] ${phase}`);
  }
}
