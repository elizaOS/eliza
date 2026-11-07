/**
 * A recorded prompt duration of 0 is a finished instant. `durationMs || elapsed`
 * replaced it with the wall-clock time since the prompt started.
 */
export function recordedPromptDurationMs(
  durationMs: number | null | undefined,
  elapsedMs: number,
): number {
  if (typeof durationMs === "number" && Number.isFinite(durationMs))
    return durationMs;
  return elapsedMs;
}
