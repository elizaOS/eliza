/**
 * Tool-call cache — public types.
 *
 * The cache wraps tool execution. Given a (toolName, args) pair, it computes a
 * stable hash, looks up an entry in either the in-memory LRU or the on-disk
 * tier, and returns the cached output if it has not expired and matches the
 * tool's recorded version. Side-effect tools opt out via the `cacheable`
 * flag on their definition.
 */

export type ToolArgs = Record<string, unknown>;

/**
 * Tool output type. Tools may return arbitrary JSON-serialisable data.
 * We constrain to JSON-friendly shapes so the disk tier can persist them.
 */
export type ToolOutput =
  | string
  | number
  | boolean
  | null
  | ToolOutput[]
  | { [key: string]: ToolOutput };

export interface ToolCacheEntry {
  /** sha256 of the canonicalized (toolName, args) pair. */
  key: string;
  /** Tool name used to compute the key (for diagnostics + invalidation). */
  toolName: string;
  /** Tool implementation version used when the entry was written. */
  toolVersion: string;
  /** UTC ms when the entry was written. */
  cachedAt: number;
  /** UTC ms when the entry should be considered expired. */
  expiresAt: number;
  /** Cached tool output. */
  output: ToolOutput;
}

export interface CacheableToolDescriptor {
  name: string;
  /** Implementation version. Bumping invalidates all prior cache entries. */
  version: string;
  /** Per-tool TTL in ms. */
  ttlMs: number;
  /**
   * Whether this tool may be cached. Side-effect tools (send_email,
   * post_message, write_file, run_code) MUST set this to `false`.
   */
  cacheable: boolean;
}

/**
 * Strip personally-identifiable information from a value before persisting
 * it to disk. Implementations must be pure and synchronous so the cache
 * write path stays predictable.
 */
export type PrivacyRedactor = (value: unknown) => unknown;
