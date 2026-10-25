/**
 * Safely open an `EventSource`.
 *
 * The browser `EventSource` constructor only accepts http(s) URLs and throws a
 * synchronous `SecurityError: The operation is insecure` for any other scheme.
 * The iOS on-device agent is addressed through the `eliza-local-agent://ipc`
 * base, whose SSE routes are served over the native IPC bridge rather than a
 * real socket — so constructing an `EventSource` against it crashes whatever
 * surface mounted the subscription (e.g. the home model-status hook), which is
 * how the local-agent chat surface fell over with "The operation is insecure."
 *
 * Returning `null` (instead of throwing) lets callers degrade to their
 * fetch/poll path. `null` is also returned when `EventSource` is unavailable or
 * the URL is unparseable, so callers only need a single nullish check.
 */
export function openEventSource(
  url: string,
  init?: EventSourceInit,
): EventSource | null {
  if (typeof EventSource === "undefined") return null;
  const base =
    typeof window !== "undefined" ? window.location.href : "http://localhost";
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    // error-policy:J3 unparseable URL — callers degrade to their fetch/poll
    // path (see header).
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  try {
    return new EventSource(url, init);
  } catch {
    // error-policy:J4 EventSource constructor rejected the URL (see header —
    // the iOS IPC base case); callers degrade to their fetch/poll path.
    return null;
  }
}
