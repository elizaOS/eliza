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
