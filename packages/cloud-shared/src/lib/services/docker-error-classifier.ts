/**
 * Tiny dep-free helpers to classify errors returned by `docker` / SSH so
 * the rest of the sandbox provider can stay readable. Extracted from
 * `docker-sandbox-provider.ts` only so the helpers can be unit-tested
 * without pulling in plugin-sql / drizzle / @elizaos/core at import time.
 */

/**
 * Matches Docker / SSH error messages that mean "the thing we tried to
 * stop is no longer there". Used by `DockerSandboxProvider.stop()` to
 * treat both-calls-failed as success when the container was already gone
 * before we got the SSH window. Substring match because docker error
 * formatting drifts across versions ("No such container", "is not
 * running", etc.).
 */
export function isAlreadyGoneMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no such container") ||
    normalized.includes("not found") ||
    normalized.includes("already gone") ||
    normalized.includes("no longer exists")
  );
}

/**
 * Matches network-level error messages that mean "the node hosting the
 * container is UNREACHABLE" — SSH connect/exec timeouts, refused/unreachable
 * sockets, DNS failure. Used by `DockerSandboxProvider.stop()` to treat an
 * unreachable-node delete as TERMINAL ("container gone") rather than a
 * retryable failure: re-queuing such a delete re-runs the ~20-65s stop path
 * every cycle and can push the work cycle past the 300s watchdog, withholding
 * the liveness heartbeat so the cloud-api fails closed and the agents API
 * hangs.
 *
 * Kept deliberately NARROW (network-level tokens only) so it never swallows a
 * legitimate Docker-daemon error — do NOT add generic words like "error".
 */
export function isNodeUnreachableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnrefused") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("enetunreach") ||
    normalized.includes("connection error") ||
    normalized.includes("connect to host") ||
    normalized.includes("getaddrinfo") ||
    normalized.includes("no route to host")
  );
}
