/**
 * What a failed job records about why it failed.
 *
 * Job rows stored `error.message` alone, so `agent_delete` failures have sat at
 * 35 bytes — "value.toISOString is not a function" — across 342 production
 * occurrences with nothing to locate the call site from (#23117). One of them
 * has been undeletable since 2026-07-07 for want of a stack.
 *
 * Bounded because the same column is already the wrong size in the other
 * direction: 33 rows exceed 100 KB from payload dumps, and a grouping query
 * over it failed outright with `invalid memory alloc request size 1130945444`.
 * Cutting on characters rather than bytes keeps multi-byte sequences intact.
 *
 * Dependency-free on purpose so it stays testable without the job service's
 * database import graph.
 */
const JOB_ERROR_MAX_CHARS = 4_000;

export function jobErrorText(error: unknown): string {
  const raw =
    error instanceof Error ? (error.stack?.trim() || error.message) : String(error);
  return raw.length <= JOB_ERROR_MAX_CHARS
    ? raw
    : `${raw.slice(0, JOB_ERROR_MAX_CHARS)}\n… truncated`;
}
