/**
 * Default deadlines for short control-plane requests. Model execution and
 * model-adjacent lifecycle routes remain open until their owner cancels them.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

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
): number | undefined {
  const pathname = requestPathname(path);
  if (
    pathname.startsWith("/api/local-inference/") ||
    pathname === "/api/tts/local-inference" ||
    pathname === "/api/asr/local-inference" ||
    pathname === "/api/asr/cloud" ||
    pathname === "/api/agent/reset"
  ) {
    return undefined;
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  if (
    pathname === "/api/inbox/messages" ||
    /^\/api\/conversations\/[^/]+\/messages(?:\/stream)?$/.test(pathname)
  ) {
    return undefined;
  }
  if (pathname === "/api/conversations") {
    return undefined;
  }
  return DEFAULT_FETCH_TIMEOUT_MS;
}
