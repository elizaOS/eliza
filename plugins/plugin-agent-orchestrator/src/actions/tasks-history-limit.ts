/** Parses bounded history limits for the TASKS action without loading the orchestrator runtime graph. */

/** Hard ceiling on a single history page. Larger canonical requests are
 * honored up to this ceiling and the reduction is REPORTED via `clampedFrom`
 * (prompt-integrity: a clamped caller limit must be echoed, never silent) so
 * the caller pages with `offset` instead of believing it saw everything. */
export const MAX_HISTORY_LIMIT = 100;

export interface HistoryLimit {
  limit: number;
  /** Present when the caller's canonical request exceeded
   * {@link MAX_HISTORY_LIMIT}: the limit that was actually requested. Callers
   * must surface this (e.g. in `data.filters`) so the clamp is visible. */
  clampedFrom?: number;
}

/** Accepts positive canonical integers and otherwise preserves the caller's metric-specific fallback. */
export function parseHistoryLimit(
  value: unknown,
  fallback: number,
): HistoryLimit {
  let parsed: number | undefined;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) parsed = value;
  } else if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const candidate = Number(value);
    if (Number.isSafeInteger(candidate)) parsed = candidate;
  }
  if (parsed === undefined) return { limit: fallback };
  return parsed > MAX_HISTORY_LIMIT
    ? { limit: MAX_HISTORY_LIMIT, clampedFrom: parsed }
    : { limit: parsed };
}

/** Parses the caller's continuation offset: canonical non-negative integers
 * only; anything else starts from the top (offset 0). */
export function parseHistoryOffset(value: unknown): number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export interface HistoryPage<T> {
  /** The requested window of `items`. */
  page: T[];
  /** Total matching items BEFORE windowing — the count callers echo. */
  total: number;
  /** True when items exist past the window (continue at `offset + page.length`). */
  hasMore: boolean;
}

/** Explicit continuation window (prompt-integrity: caller-requested
 * pagination): the page is `items[offset, offset + limit)` and the pre-slice
 * total + hasMore travel with it so nothing is silently clipped. */
export function paginateHistory<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): HistoryPage<T> {
  const page = items.slice(offset, offset + limit);
  return {
    page: [...page],
    total: items.length,
    hasMore: offset + page.length < items.length,
  };
}
