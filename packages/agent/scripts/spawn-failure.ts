/**
 * Why a build-time child process (bun, PGlite generators) did not succeed, in
 * one line. spawnSync reports a missing binary, a timeout or a signal in
 * fields that `status !== 0` alone hides, which left "could not make the
 * snapshot" with no cause.
 */
export interface SpawnOutcome {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error & { code?: string };
}

export function describeSpawnFailure(
  command: string,
  result: SpawnOutcome,
): string | null {
  const { error } = result;
  if (error) {
    if (error.code === "ENOENT") {
      return `${command} was not found on PATH (spawn ENOENT); install it or put it on PATH`;
    }
    if (error.code === "ETIMEDOUT") {
      return `${command} timed out and was killed`;
    }
    // ENOBUFS (output over maxBuffer) and similar arrive after the child ran.
    return `${command} failed: ${error.code ? `${error.code} ` : ""}${error.message}`;
  }
  if (result.signal) return `${command} was killed by ${result.signal}`;
  if (result.status !== 0)
    return `${command} exited with status ${result.status}`;
  return null;
}
