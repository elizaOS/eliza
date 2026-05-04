/**
 * Pure helper functions for bounded in-memory data structures.
 * Extracted from server.ts so they can be unit-tested in isolation.
 *
 * @module
 */

// ── Rate-limit map sweep ──────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Evict expired entries from a rate-limit map when it exceeds `threshold`.
 * Safe to call during iteration (Map spec permits deletion during for-of).
 */
export function sweepExpiredEntries(
  map: Map<string, RateLimitEntry>,
  now: number,
  threshold: number,
): void {
  if (map.size <= threshold) return;
  for (const [k, v] of map) {
    if (now > v.resetAt) map.delete(k);
  }
}

// ── Conversation soft cap ─────────────────────────────────────────────

interface ConversationLike {
  updatedAt: string;
}

/**
 * Evict the oldest conversation (by `updatedAt`) when the map exceeds `cap`.
 * Returns the evicted key, or null if no eviction was needed.
 */
export function evictOldestConversation<T extends ConversationLike>(
  map: Map<string, T>,
  cap: number,
): string | null {
  if (map.size <= cap) return null;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [k, v] of map) {
    const t = new Date(v.updatedAt).getTime();
    if (t < oldestTime) {
      oldestTime = t;
      oldestKey = k;
    }
  }
  if (oldestKey) map.delete(oldestKey);
  return oldestKey;
}

// ── Log buffer batch eviction ─────────────────────────────────────────

/**
 * Push an entry to a bounded buffer and batch-evict when the high-water
 * mark is reached.  Returns the current buffer length.
 *
 * @param buffer   - The array to push into.
 * @param entry    - The item to append.
 * @param highWater - Trigger eviction when `buffer.length` exceeds this.
 * @param evictCount - Number of oldest entries to remove on eviction.
 */
export function pushWithBatchEvict<T>(
  buffer: T[],
  entry: T,
  highWater: number,
  evictCount: number,
): number {
  buffer.push(entry);
  if (buffer.length > highWater) {
    buffer.splice(0, evictCount);
  }
  return buffer.length;
}

// ── Static file cache ─────────────────────────────────────────────────

interface CachedFile {
  body: Buffer;
  mtimeMs: number;
}

/**
 * Retrieve a file from a bounded cache, reading from disk on miss.
 * Files larger than `fileSizeLimit` are never cached.
 *
 * @param cache         - The Map serving as the LRU-ish cache.
 * @param filePath      - Absolute path to the file.
 * @param mtimeMs       - File's last-modified time (for invalidation).
 * @param readFile      - Callback that reads the file (injected for testing).
 * @param maxEntries    - Maximum number of cached files.
 * @param fileSizeLimit - Maximum file size (bytes) eligible for caching.
 */
export function getOrReadCachedFile(
  cache: Map<string, CachedFile>,
  filePath: string,
  mtimeMs: number,
  readFile: (p: string) => Buffer,
  maxEntries: number,
  fileSizeLimit: number,
): Buffer {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.body;

  const body = readFile(filePath);
  if (body.length <= fileSizeLimit) {
    if (cache.size >= maxEntries) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(filePath, { body, mtimeMs });
  }
  return body;
}
