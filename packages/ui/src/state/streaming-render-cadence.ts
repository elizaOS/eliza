/**
 * Scheduling primitives for cumulative chat-stream paints. Transport events
 * are cadence-bounded before browser work is aligned with a render frame;
 * non-DOM runtimes retain a microtask fallback for forward progress.
 */

/** Roughly 16 transcript commits/second while a model is streaming. */
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

/** Request one render-aligned stream flush. */
export function requestStreamingRenderFrame(
  callback: () => void,
): number | null {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(() => callback());
  }
  queueMicrotask(callback);
  return null;
}

/** Cancel a browser-scheduled stream flush. Microtask fallbacks use generation guards. */
export function cancelStreamingRenderFrame(frameId: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frameId);
  }
}
