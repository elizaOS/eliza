/**
 * Session pool for the in-process node-llama-cpp engine.
 *
 * node-llama-cpp's `LlamaChatSession` keeps an internal KV cache. The
 * stock engine code resets that cache between every turn, which is
 * correct for stateless per-call generation but actively defeats prefix
 * reuse for callers that pass a `promptCacheKey` (the runtime's
 * cloud-style cache hint).
 *
 * This pool keeps one session per `promptCacheKey`, LRU-evicted, so
 * sequential calls with the same key reuse the on-GPU/on-CPU KV cache.
 * Calls without a cache key share the synthetic `_default` slot, which
 * preserves the previous "stateless per-call" semantics by resetting
 * before each turn.
 *
 * The pool owns nothing at module scope; the engine constructs a pool
 * tied to the loaded model and disposes it on unload.
 */

export interface PoolSession {
  /** Reset accumulated chat history. Called for the default slot only. */
  resetChatHistory?(): void | Promise<void>;
  /** Dispose underlying KV state. Called on eviction + on pool close. */
  dispose?(): void | Promise<void>;
}

export type SessionFactory<TSession extends PoolSession> = (
  key: string,
) => Promise<TSession>;

interface Entry<TSession extends PoolSession> {
  key: string;
  session: TSession;
  /** Wall-clock ms of last access. Used purely to break LRU ties. */
  lastUsedMs: number;
}

/**
 * Synthetic key used for callers that didn't supply a `promptCacheKey`.
 * These callers want the old "history-free" behaviour, so the engine
 * resets chat history each turn for this slot only.
 */
export const DEFAULT_SESSION_KEY = "_default";

export class SessionPool<TSession extends PoolSession> {
  private readonly maxSize: number;
  private readonly factory: SessionFactory<TSession>;
  /**
   * Insertion order = LRU order. We re-key on each access so the most
   * recently used entry is always last in iteration order.
   */
  private readonly entries = new Map<string, Entry<TSession>>();

  constructor(args: {
    maxSize: number;
    factory: SessionFactory<TSession>;
  }) {
    if (!Number.isFinite(args.maxSize) || args.maxSize < 1) {
      throw new Error(
        `[session-pool] maxSize must be >= 1, got ${args.maxSize}`,
      );
    }
    this.maxSize = Math.floor(args.maxSize);
    this.factory = args.factory;
  }

  /**
   * Get-or-create the session for `key`. Promotes the entry to MRU.
   * On eviction, the oldest entry's `dispose()` is awaited before the
   * new entry is returned so the caller never holds two live sessions
   * over the same KV memory.
   */
  async acquire(key: string): Promise<TSession> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      existing.lastUsedMs = Date.now();
      this.entries.set(key, existing);
      return existing.session;
    }

    while (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) await this.disposeQuietly(oldest.session);
    }

    const session = await this.factory(key);
    this.entries.set(key, {
      key,
      session,
      lastUsedMs: Date.now(),
    });
    return session;
  }

  /** Number of live sessions, for diagnostics. */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot of live keys ordered LRU → MRU. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Drop a single session by key. Used when the caller knows the prefix
   * has gone stale (e.g. system prompt changed) and the cached KV is no
   * longer valid.
   */
  async drop(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await this.disposeQuietly(entry.session);
  }

  /**
   * Tear down every cached session. Called by the engine on model
   * unload. After `close()` the pool is empty but reusable.
   */
  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      await this.disposeQuietly(entry.session);
    }
  }

  private async disposeQuietly(session: TSession): Promise<void> {
    if (typeof session.dispose !== "function") return;
    try {
      await session.dispose();
    } catch {
      // Eviction is best-effort: if the underlying binding throws, we still
      // need the slot freed in the pool.
    }
  }
}

/**
 * Resolve the pool size from env, with a sane default. Bound by 1..64.
 */
export function resolveDefaultPoolSize(envValue?: string | null): number {
  const raw = (envValue ?? "").trim();
  if (!raw) return 8;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 8;
  return Math.min(64, Math.max(1, parsed));
}
