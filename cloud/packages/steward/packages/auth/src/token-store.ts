/**
 * TokenStore — persists magic-link token hashes with per-entry TTL.
 *
 * Backed by a pluggable StoreBackend (Redis, Postgres, or in-memory).
 * The default (zero-config) backend is MemoryBackend, preserving
 * backward-compatible behavior.
 *
 * Public API is intentionally unchanged:  store(), verify(), delete(), destroy().
 *
 * To use a persistent backend, pass it at construction time:
 *
 *   import { RedisBackend } from "./store-backends";
 *   const ts = new TokenStore({ backend: new RedisBackend(redisClient) });
 */

import type { StoreBackend } from "./store-backends";
import { MemoryBackend } from "./store-backends";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface TokenStoreOptions {
  /** Override the default in-memory backend with a persistent implementation. */
  backend?: StoreBackend;
}

export class TokenStore {
  private readonly backend: StoreBackend;

  constructor(options: TokenStoreOptions = {}) {
    this.backend = options.backend ?? new MemoryBackend();
  }

  /**
   * Store a hash → email mapping with a TTL.
   * @param hash   SHA-256 hex of the raw token
   * @param email  Email address tied to this token
   * @param ttlMs  Time-to-live in milliseconds (default 10 min)
   */
  store(hash: string, email: string, ttlMs: number = DEFAULT_TTL_MS): void {
    void this.backend.set(hash, email, ttlMs);
  }

  /**
   * Verify a hash and return the associated email if it exists and hasn't expired.
   * Does NOT delete the entry — call delete() explicitly after use.
   */
  async verify(hash: string): Promise<string | null> {
    return this.backend.get(hash);
  }

  /**
   * Delete a hash from the store (called after one-time token consumption).
   */
  delete(hash: string): void {
    void this.backend.delete(hash);
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
}
