/**
 * Browser scheduling primitives for work that must stay off the initial render path.
 */
export interface IdleScheduler {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export function scheduleWhenIdle(
  callback: () => void,
  scheduler: IdleScheduler,
  timeout = 1_500,
): () => void {
  let active = true;
  const run = () => {
    if (active) callback();
  };

  if (scheduler.requestIdleCallback && scheduler.cancelIdleCallback) {
    const handle = scheduler.requestIdleCallback(run, { timeout });
    return () => {
      active = false;
      scheduler.cancelIdleCallback?.(handle);
    };
  }

  const handle = scheduler.setTimeout(run, Math.min(timeout, 500));
  return () => {
    active = false;
    scheduler.clearTimeout(handle);
  };
}
