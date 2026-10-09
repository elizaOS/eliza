/** Maps complete inputs with bounded admission, stable order and prompt failure. */
export function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    return Promise.reject(
      new RangeError(
        `mapWithConcurrency limit must be a positive integer (got ${String(limit)})`,
      ),
    );
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failed = false;
  async function work(): Promise<void> {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        // error-policy:J2 stop admission; Promise.all observes every worker rejection.
        failed = true;
        throw error;
      }
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, work),
  ).then(() => results);
}
