const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const CHAT_MESSAGE_FETCH_TIMEOUT_MS = 5 * 60_000;

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
  return DEFAULT_FETCH_TIMEOUT_MS;
}
