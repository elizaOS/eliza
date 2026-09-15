/** Owns the total SDK polling budget across requests, response bodies and waits. */

interface PollOptions<T> {
  read(options: { timeoutMs: number; signal?: AbortSignal }): Promise<T>;
  isComplete(value: T): boolean;
  timeoutMs: number;
  intervalMs: number;
  timeoutMessage: string;
  signal?: AbortSignal;
  cancellationMessage?: string;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `${name} must be an integer between 0 and ${MAX_TIMER_DELAY_MS} milliseconds`,
    );
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  validateDelay("timeoutMs", options.timeoutMs);
  validateDelay("intervalMs", options.intervalMs);
  const deadline = performance.now() + options.timeoutMs;
  const checkCancellation = (): void => {
    if (options.signal?.aborted) {
      if (options.cancellationMessage) {
        throw new Error(options.cancellationMessage, {
          cause: options.signal.reason,
        });
      }
      options.signal.throwIfAborted();
    }
  };
  for (;;) {
    checkCancellation();
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error(options.timeoutMessage);
    let result: T;
    try {
      result = await options.read({
        timeoutMs: remaining,
        signal: options.signal,
      });
    } catch (error) {
      // error-policy:J2 Add polling context to deadline/cancellation failures; preserve other transport failures.
      checkCancellation();
      if (performance.now() >= deadline) {
        throw new Error(options.timeoutMessage, { cause: error });
      }
      throw error;
    }
    checkCancellation();
    if (performance.now() >= deadline) throw new Error(options.timeoutMessage);
    if (options.isComplete(result)) return result;
    await wait(
      Math.min(options.intervalMs, Math.ceil(deadline - performance.now())),
      options.signal,
    );
  }
}
