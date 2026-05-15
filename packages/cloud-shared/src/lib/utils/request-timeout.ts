const MIN_ROUTE_TIMEOUT_MS = 1_000;
const ROUTE_TIMEOUT_BUFFER_MS = 10_000;

/**
 * Abort work shortly before the platform request budget elapses so routes can
 * unwind billing and stream state instead of being terminated mid-request.
 */
export function getRouteTimeoutMs(
  maxDurationSeconds: number,
  bufferMs: number = ROUTE_TIMEOUT_BUFFER_MS,
): number {
  return Math.max(MIN_ROUTE_TIMEOUT_MS, maxDurationSeconds * 1000 - bufferMs);
}
