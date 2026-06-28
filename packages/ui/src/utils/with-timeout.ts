/**
 * Reject if `promise` does not settle within `ms`. Home widgets fetch through
 * the native/desktop agent bridge, whose RPC can hang indefinitely early in
 * boot (the channel isn't ready) — without a bound, the widget's catch never
 * fires and the tile spins on "Loading…" forever. Wrapping the call lets the
 * widget settle to its empty / connect state instead.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
