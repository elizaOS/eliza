/**
 * ChallengeStore — persists WebAuthn challenges with per-entry TTL.
 *
 * Backed by a pluggable StoreBackend (Redis, Postgres, or in-memory).
 * The default (zero-config) backend is MemoryBackend, preserving
 * backward-compatible behavior.
 *
 * Public API is intentionally unchanged so existing call-sites don't need
 * to be updated:  set(), get(), consume(), delete(), destroy(), size.
 *
 * To use a persistent backend, pass it at construction time:
 *
 *   import { RedisBackend } from "./store-backends";
 *   const store = new ChallengeStore({ backend: new RedisBackend(redisClient) });
 */

import type { StoreBackend } from "./store-backends";
import { MemoryBackend } from "./store-backends";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface ChallengeStoreOptions {
  /** Override the default in-memory backend with a persistent implementation. */
  backend?: StoreBackend;
  /** Custom TTL in milliseconds for each challenge. Default: 5 minutes. */
  ttlMs?: number;
}

export class ChallengeStore {
  private readonly backend: StoreBackend;
  private readonly ttlMs: number;

  constructor(options: ChallengeStoreOptions | number = {}) {
    // Accept bare number for backward compat: `new ChallengeStore(ttlMs)`
    if (typeof options === "number") {
      this.ttlMs = options;
      this.backend = new MemoryBackend();
    } else {
      this.ttlMs = options.ttlMs ?? CHALLENGE_TTL_MS;
      this.backend = options.backend ?? new MemoryBackend();
    }
  }

  /** Store a challenge for a given key (userId or email). Overwrites any existing entry. */
  set(key: string, challenge: string): void {
    void this.backend.set(key, challenge, this.ttlMs);
  }

  /**
   * Retrieve and immediately delete a challenge (one-time-use).
   * Returns null if missing or expired.
   *
   * NOTE: Because backends are async, this returns a Promise.
   * Existing code that ignores the return value continues to work.
   * Code that needs the value should await it.
   */
  async consume(key: string): Promise<string | null> {
    const value = await this.backend.get(key);
    if (!value) return null;
    await this.backend.delete(key);
    return value;
  }

  /** Peek at a challenge without consuming it. Returns null if missing or expired. */
  async get(key: string): Promise<string | null> {
    return this.backend.get(key);
  }

  /** Delete a challenge explicitly. */
  delete(key: string): void {
    void this.backend.delete(key);
  }

  /**
   * Stop background cleanup timers (no-op for Redis/Postgres backends).
   * Useful in tests when using the default MemoryBackend.
   */
  destroy(): void {
    if (this.backend instanceof MemoryBackend) {
      this.backend.destroy();
    }
  }

  /** Current number of stored entries — only meaningful for MemoryBackend. */
  get size(): number {
    if (this.backend instanceof MemoryBackend) {
      return this.backend.size;
    }
    return 0;
  }
}

/** Singleton default store using in-memory backend — use this unless you need isolation. */
export const challengeStore = new ChallengeStore();
