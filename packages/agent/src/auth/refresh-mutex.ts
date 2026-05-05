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
   * the same key wait for the in-flight promise to settle, then run
   * their own attempt — they do NOT share the result. The caller is
   * expected to re-check state (e.g. re-read credentials) after acquire.
   */
  async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.inflight.get(key);
    if (previous) {
      await previous.catch(() => {});
    }
    const next = (async () => fn())();
    this.inflight.set(key, next);
    try {
      return await next;
    } finally {
      if (this.inflight.get(key) === next) {
        this.inflight.delete(key);
      }
    }
  }
}

export const accountRefreshMutex = new KeyedMutex();
