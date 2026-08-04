/**
 * Shared cadence for cumulative chat-stream paints. Transport callbacks may
 * arrive faster than the overlay can render, so intermediate snapshots are
 * bounded while the first token and terminal state remain immediate.
 */

/** Roughly 16 paints/second, comfortably below the 100 ms response threshold. */
export const STREAMING_RENDER_INTERVAL_MS = 64;

/** Delay until the next intermediate stream snapshot may paint. */
export function streamingRenderDelayMs(
  lastPaintAtMs: number | null,
  nowMs: number,
): number {
  if (lastPaintAtMs === null) return 0;
  const elapsedMs = Math.max(0, nowMs - lastPaintAtMs);
  return Math.max(0, STREAMING_RENDER_INTERVAL_MS - elapsedMs);
}
