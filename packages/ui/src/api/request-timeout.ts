const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
// Local neural TTS on mobile CPU is slower than ordinary JSON API calls. Pixel
// APK validation with the bundled Kokoro path produced normal chat clips in the
// 15-30 s range, so the generic 10 s bridge timeout aborts valid responses
// before the WAV is ready.
const LOCAL_INFERENCE_TTS_FETCH_TIMEOUT_MS = 3 * 60_000;
// First-turn inference on Capacitor mobile (Moto G Play 2024, Snapdragon
// 4 Gen 1, CPU-only) lands at ~240 s for a 256-token Llama-3.2-1B reply.
// The bun-side `ELIZA_CHAT_GENERATION_TIMEOUT_MS` is 600 s on that build
// (set by `ElizaAgentService.java`); a tighter client-side budget would
// abort the SSE stream while bun is still emitting tokens, the row would
// still land in the conversation DB, but the renderer would stay frozen
// on the typing indicator with no response visible. Match the bun ceiling
// so the two layers fail/succeed together.
const CHAT_MESSAGE_FETCH_TIMEOUT_MS = 10 * 60_000;

function requestPathname(path: string): string {
  try {
    return new URL(path, "http://eliza.local").pathname;
  } catch {
    return path.split(/[?#]/, 1)[0] ?? path;
  }
}

export function defaultFetchTimeoutMs(
  path: string,
  init?: RequestInit,
): number {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  const pathname = requestPathname(path);
  if (
    pathname === "/api/inbox/messages" ||
    /^\/api\/conversations\/[^/]+\/messages(?:\/stream)?$/.test(pathname)
  ) {
    return CHAT_MESSAGE_FETCH_TIMEOUT_MS;
  }
  if (pathname === "/api/tts/local-inference") {
    return LOCAL_INFERENCE_TTS_FETCH_TIMEOUT_MS;
  }
  return DEFAULT_FETCH_TIMEOUT_MS;
}
