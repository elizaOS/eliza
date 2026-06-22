/**
 * Timing helpers shared by the voice self-test harness and the workbench
 * player. `now()` reads a monotonic clock when available; `sleep()` awaits a
 * fixed delay.
 */

export const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : 0;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
