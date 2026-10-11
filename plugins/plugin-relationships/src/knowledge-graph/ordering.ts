/**
 * Ordering helpers shared by the graph stores: per-key serialization for
 * read-then-write operations on backends without a record transaction, and
 * later-wins comparison for recency timestamps.
 */

/** The later of two instants; an older backfilled observation must not rewind recency. */
export function laterIso(current: string | undefined, next: string): string {
  return current && Date.parse(current) > Date.parse(next) ? current : next;
}

/**
 * Runs `work` after every earlier call with the same key has settled. The SQL
 * adapters give a store operation no transaction, so a read-then-write on one
 * edge or entity would otherwise race another and let the stale read win.
 */
const queues = new Map<string, Promise<void>>();
export function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
