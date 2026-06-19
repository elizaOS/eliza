/**
 * Wraps a promise with a timeout — rejects with an error if the deadline
 * expires. This is a promise-race: it frees the *awaiter* after `ms`, it does
 * NOT abort the underlying work. Use it only where every leaf is already
 * independently bounded (its own SSH/HTTP/Redis timeout), so a rejected race
 * never leaves truly-unbounded I/O running behind it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
