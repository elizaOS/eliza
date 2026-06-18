/**
 * Runtime-ready gate — lets a request HOLD through the brief warming window
 * between the early API bind (agentState "starting", runtime not yet wired) and
 * the moment the runtime is live, instead of 503-dropping the request.
 *
 * This is what makes first-turn capability "fade in" without losing the user's
 * message: a chat turn submitted during warmup keeps its connection open (the
 * client already shows the optimistic bubble + typing indicator) and streams its
 * response the instant the runtime is ready — typically ~2s, bounded by a
 * timeout so a genuinely-stuck boot still fails fast rather than hanging forever.
 *
 * Dependency-free + side-effect-free so it unit-tests in isolation.
 */
export interface RuntimeReadyGate<T> {
  /**
   * Resolves immediately with the current value if one exists, otherwise waits
   * until `markReady` is called or `timeoutMs` elapses — on timeout it resolves
   * with whatever `getCurrent()` returns then (possibly null).
   */
  await(timeoutMs: number): Promise<T | null>;
  /** Wake all current + drop pending waiters, resolving them with `value`. */
  markReady(value: T): void;
}

export function createRuntimeReadyGate<T>(
  getCurrent: () => T | null,
): RuntimeReadyGate<T> {
  const waiters = new Set<(value: T | null) => void>();

  return {
    await(timeoutMs: number): Promise<T | null> {
      const current = getCurrent();
      if (current != null) {
        return Promise.resolve(current);
      }
      return new Promise<T | null>((resolve) => {
        let settled = false;
        const settle = (value: T | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(value);
        };
        const waiter = (value: T | null): void => settle(value);
        const timer = setTimeout(() => settle(getCurrent()), timeoutMs);
        // Don't keep the process alive just for a warming-window waiter.
        (timer as { unref?: () => void }).unref?.();
        waiters.add(waiter);
      });
    },

    markReady(value: T): void {
      const pending = [...waiters];
      waiters.clear();
      for (const wake of pending) {
        wake(value);
      }
    },
  };
}
