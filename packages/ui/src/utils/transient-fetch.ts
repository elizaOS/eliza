/**
 * Recognise transient fetch failures that should NOT be surfaced as a console
 * warning during best-effort startup/hydration work. Two shapes:
 *
 *  - the app's `ApiError` with `kind === "network"` and a message of
 *    "Failed to fetch" / "Request aborted" (a request that never got an HTTP
 *    response — connection reset, navigation away, server not yet up); and
 *  - a raw `TypeError: Failed to fetch` / "NetworkError" / "Load failed"
 *    (fetch() rejecting before any response — same root cause, but the call
 *    site didn't wrap it in an ApiError).
 *
 * Every fetch that is "best effort and re-driven by a later poll" can use this
 * to decide whether a failure is worth logging. It is NOT for fetches whose
 * failure is a real bug — only for the optional hydration ones.
 */
export function isTransientOptionalFetchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    err.name === "TypeError" &&
    /^(Failed to fetch|NetworkError|Load failed)$/i.test(err.message)
  ) {
    return true;
  }
  return (
    err.name === "ApiError" &&
    (err as Error & { kind?: string }).kind === "network" &&
    /^(Failed to fetch|Request aborted)$/i.test(err.message)
  );
}
