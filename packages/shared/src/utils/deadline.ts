/**
 * Provides the canonical promise deadline engine while leaving timeout budgets
 * and boundary-specific error or fallback policies with each subsystem.
 */

export interface DeadlineOptions<TTimeout> {
  timeoutMs: number;
  onTimeout: () => TTimeout;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/** Resolve the source promise or the boundary-owned timeout value. */
export async function resolveAtDeadline<T, TTimeout>(
  promise: Promise<T>,
  options: DeadlineOptions<TTimeout>,
): Promise<T | TTimeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TTimeout>((resolve) => {
        timer = setTimeout(
          () => resolve(options.onTimeout()),
          options.timeoutMs,
        );
        unrefTimer(timer);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Reject with the boundary-owned error when the source misses its deadline. */
export function rejectAtDeadline<T>(
  promise: Promise<T>,
  options: DeadlineOptions<Error>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(options.onTimeout()), options.timeoutMs);
    unrefTimer(timer);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
