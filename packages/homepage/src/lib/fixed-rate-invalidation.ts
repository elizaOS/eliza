/**
 * Fixed-rate render invalidation that remains independent of display refresh rate.
 */
export const AMBIENT_FRAME_RATE = 30;
export const AMBIENT_FRAME_INTERVAL_MS = 1_000 / AMBIENT_FRAME_RATE;

export interface IntervalScheduler {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(handle: number): void;
}

export function startFixedRateInvalidation(
  invalidate: () => void,
  scheduler: IntervalScheduler,
): () => void {
  invalidate();
  const handle = scheduler.setInterval(invalidate, AMBIENT_FRAME_INTERVAL_MS);
  return () => scheduler.clearInterval(handle);
}
