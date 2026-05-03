/**
 * Infrastructure / Cache layer — `Cached*Repository` decorators.
 *
 * Each decorator wraps a domain repository, owns the cache keys and TTLs for
 * its aggregate, and handles invalidation on writes. Composes a `Cache`
 * (`@/lib/domain/cache/cache`) with an inner `*Repository`.
 *
 * Aggregates added one folder at a time. Phase A: empty.
 */

export {};
