/**
 * Creates a serialised (sequential) promise queue.
 *
 * Each call to the returned function chains the provided async `fn` after
 * the previous one completes, ensuring only one operation runs at a time.
 *
 * Usage:
 *   const run = createSerialise();
 *   await run(async () => { ... });
 */
export function createSerialise(): <T>(fn: () => Promise<T>) => Promise<T> {
  let lock: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = lock;
    let resolve: () => void;
    lock = new Promise<void>((r) => {
      resolve = r;
    });
    return prev.then(fn).finally(() => resolve?.());
  };
}
