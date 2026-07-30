/**
 * Frame scheduler for cumulative chat-stream paints. Browser render work is
 * aligned with requestAnimationFrame; non-DOM runtimes retain a microtask
 * fallback so native and unit-test streams still make forward progress.
 */

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
