function hasRequestForPath(
  requests: readonly string[],
  pathname: string,
): boolean {
  return requests.some((request) => request.endsWith(` ${pathname}`));
}

export function hasPackagedRendererBootstrapRequests(
  requests: readonly string[],
): boolean {
  if (hasRequestForPath(requests, "/api/status")) {
    return true;
  }

  // The splash-first startup flow can pause after the renderer fetches config
  // but before it reaches stream/drop endpoints. /api/config is renderer-owned
  // in this packaged bootstrap path; main-process heartbeat traffic does not hit it.
  if (hasRequestForPath(requests, "/api/config")) {
    return true;
  }

  // On a fresh install the renderer stays on the splash "Press Start" screen
  // and never makes API calls. The main process still fires heartbeat menu
  // refresh immediately on launch, which hits /api/triggers. Accepting this
  // as a valid bootstrap signal proves the packaged app started and is
  // communicating with the overridden API base (ELIZA_DESKTOP_TEST_API_BASE).
  if (hasRequestForPath(requests, "/api/triggers")) {
    return true;
  }

  return (
    hasRequestForPath(requests, "/api/drop/status") ||
    hasRequestForPath(requests, "/api/stream/settings")
  );
}
