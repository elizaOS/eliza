/**
 * Async mutex keyed by string. Single in-flight operation per key.
 *
 * Used to serialize OAuth refresh attempts per `{providerId}:{accountId}`
 * pair so concurrent `getAccessToken` calls don't race on file writes
 * (and don't burn refresh-token grants).
 */

export class KeyedMutex {
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` while holding the lock for `key`. Concurrent callers with
   * the same key are queued and run strictly one at a time — they do NOT
   * share the result. The caller is expected to re-check state (e.g.
   * re-read credentials) after acquire.
   *
   * The queue is built synchronously: each acquirer chains off whatever
   * promise is currently registered for the key and immediately registers
   * itself as the new tail. Two callers arriving in the same tick observe
   * different predecessors, so they cannot run `fn` concurrently.
   */
  async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.inflight.get(key) ?? Promise.resolve();
    const run = previous.then(() => fn());
    // Register a non-rejecting tail so the next acquirer waits for this
    // run to settle regardless of outcome, without unhandled rejections.
    const tail = run.catch(() => {});
    this.inflight.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.inflight.get(key) === tail) {
        this.inflight.delete(key);
      }
    }
  }
}

export const accountRefreshMutex = new KeyedMutex();
