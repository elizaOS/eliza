/**
 * Defines the bounded AI SDK retry budget for latency-sensitive Shared turns.
 */

/** Resolve the operator override while preventing multi-retry backoff stalls. */
export function resolveSharedTurnMaxRetries(
  raw: string | undefined = process.env.SHARED_TURN_MAX_RETRIES,
): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 2);
}

export const SHARED_TURN_MAX_RETRIES = resolveSharedTurnMaxRetries();
