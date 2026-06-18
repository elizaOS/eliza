/**
 * resource-cache — a tiny stale-while-revalidate store shared across the app.
 *
 * The dashboard had no shared data cache: every view hand-rolled
 * `useState({ loading: true })` + a fetch-on-mount effect, so navigating away
 * and back always dropped to a spinner and re-fetched from scratch. This store
 * keeps the last successful result for a key in memory (optionally mirrored to
 * localStorage), so a revisited view paints instantly from cache and revalidates
 * in the background.
 *
 * Responsibilities, kept deliberately small:
 *   - hold the last successful value per key (data only — loading/error live in
 *     the consuming hook),
 *   - de-duplicate concurrent revalidations for the same key (one network
 *     request feeds every mounted consumer),
 *   - notify subscribers when a key's value changes.
 *
 * It is NOT a generic query library. No retries, no GC timers, no query
 * invalidation graph — just the minimum that makes navigation feel instant.
 */

interface CacheEntry<T> {
  data: T;
  updatedAt: number;
  /**
   * Memoized public snapshot with stable identity. `useSyncExternalStore`
   * compares snapshots by reference, so this must keep the same object until
   * the underlying value actually changes (i.e. until a new entry replaces it).
   */
  snapshot?: CachedSnapshot<T>;
}

/** Real successful values only — never holds in-flight placeholders. */
const store = new Map<string, CacheEntry<unknown>>();
/** Shared in-flight revalidations, so concurrent consumers issue one request. */
const inflight = new Map<string, Promise<unknown>>();
/**
 * Monotonic request counter per key. A forced refetch can run concurrently with
 * an older in-flight request; only the latest sequence is allowed to commit, so
 * a slow stale response can never clobber a newer one (last-write-wins).
 */
const requestSeq = new Map<string, number>();
const subscribers = new Map<string, Set<() => void>>();

/**
 * Ref-counted background pollers, keyed by cache key. Multiple hook mounts that
 * poll the same key share one `setInterval`: the first registrant starts the
 * timer, later ones just bump the ref-count, and the last to leave clears it.
 * This stops N mounts of the same resource from each running their own timer.
 */
interface Poller {
  intervalId: ReturnType<typeof setInterval>;
  refCount: number;
}
const pollers = new Map<string, Poller>();

/** localStorage key prefix for persisted entries. */
const PERSIST_PREFIX = "eliza:rc:";

export interface CachedSnapshot<T> {
  data: T;
  updatedAt: number;
}

function notify(key: string): void {
  const subs = subscribers.get(key);
  if (!subs) return;
  for (const fn of subs) fn();
}

function readPersisted<T>(key: string): CachedSnapshot<T> | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(`${PERSIST_PREFIX}${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { data: T; updatedAt: number };
    if (parsed && typeof parsed.updatedAt === "number") {
      return { data: parsed.data, updatedAt: parsed.updatedAt };
    }
  } catch {
    // Corrupt or unavailable storage — treat as a cold cache.
  }
  return undefined;
}

function writePersisted<T>(key: string, snapshot: CachedSnapshot<T>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${PERSIST_PREFIX}${key}`,
      JSON.stringify(snapshot),
    );
  } catch {
    // Quota or sandboxed storage — non-fatal, the in-memory entry still stands.
  }
}

/**
 * Read the current cached snapshot for a key. When `persist` is set and the
 * in-memory entry is missing, the localStorage mirror is hydrated into memory
 * so the first paint after a reload is warm.
 */
export function getCached<T>(
  key: string,
  persist = false,
): CachedSnapshot<T> | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (entry) {
    if (!entry.snapshot) {
      entry.snapshot = { data: entry.data, updatedAt: entry.updatedAt };
    }
    return entry.snapshot;
  }
  if (!persist) return undefined;
  const persisted = readPersisted<T>(key);
  if (persisted) {
    const hydrated: CacheEntry<T> = {
      data: persisted.data,
      updatedAt: persisted.updatedAt,
      snapshot: persisted,
    };
    store.set(key, hydrated);
    return persisted;
  }
  return undefined;
}

/** Overwrite the cached value for a key and notify subscribers. */
export function setCached<T>(key: string, data: T, persist = false): void {
  const entry: CacheEntry<T> = { data, updatedAt: Date.now() };
  store.set(key, entry);
  if (persist) writePersisted(key, { data, updatedAt: entry.updatedAt });
  notify(key);
}

/** Drop a key (in-memory + persisted) and notify subscribers. */
export function invalidate(key: string): void {
  store.delete(key);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`${PERSIST_PREFIX}${key}`);
    } catch {
      // ignore
    }
  }
  notify(key);
}

/** Subscribe to changes for a key. Returns an unsubscribe function. */
export function subscribe(key: string, fn: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    const current = subscribers.get(key);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) subscribers.delete(key);
  };
}

/**
 * Revalidate a key. Concurrent calls share a single in-flight request. The
 * shared request runs to completion regardless of any individual caller's
 * abort — callers that lose interest simply stop reading; they do not cancel
 * the fetch that other mounted consumers still need.
 *
 * Resolves with the fresh value on success. On failure the in-flight marker is
 * cleared and the error propagates so the caller can surface it; the previous
 * cached value (if any) is left intact.
 */
export function revalidate<T>(
  key: string,
  fetcher: () => Promise<T>,
  persist = false,
  force = false,
): Promise<T> {
  // Background revalidations de-dup onto the in-flight request. A forced
  // refetch (e.g. after a mutation) always issues a fresh request so it can't
  // be served a value fetched before the mutation landed.
  if (!force) {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
  }

  const seq = (requestSeq.get(key) ?? 0) + 1;
  requestSeq.set(key, seq);

  const promise: Promise<T> = fetcher()
    .then((data) => {
      // Only the most recent request commits; older out-of-order responses are
      // dropped so a slow stale fetch can't overwrite fresher data.
      if (requestSeq.get(key) === seq) setCached(key, data, persist);
      if (inflight.get(key) === promise) inflight.delete(key);
      return data;
    })
    .catch((err: unknown) => {
      if (inflight.get(key) === promise) inflight.delete(key);
      throw err;
    });

  inflight.set(key, promise);
  return promise;
}

/**
 * Start (or join) a shared background poll for a key. The fetcher fires every
 * `intervalMs` via {@link revalidate} (force=true), and overlapping ticks from
 * other consumers de-dup onto the same in-flight request. Exactly one timer
 * runs per key no matter how many mounts call this; the returned function
 * decrements the ref-count and clears the timer once the last consumer leaves.
 */
export function startPolling(
  key: string,
  fetcher: () => Promise<unknown>,
  intervalMs: number,
): () => void {
  const existing = pollers.get(key);
  if (existing) {
    existing.refCount += 1;
  } else {
    const intervalId = setInterval(() => {
      void revalidate(key, fetcher, false, true).catch(() => {
        // Poll failures surface through the consuming hook's own revalidate
        // call; the background timer just keeps ticking.
      });
    }, intervalMs);
    pollers.set(key, { intervalId, refCount: 1 });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const poller = pollers.get(key);
    if (!poller) return;
    poller.refCount -= 1;
    if (poller.refCount <= 0) {
      clearInterval(poller.intervalId);
      pollers.delete(key);
    }
  };
}

/** Test helper: wipe the entire cache. Not used in production code paths. */
export function __resetResourceCache(): void {
  store.clear();
  inflight.clear();
  requestSeq.clear();
  subscribers.clear();
  for (const poller of pollers.values()) clearInterval(poller.intervalId);
  pollers.clear();
}
