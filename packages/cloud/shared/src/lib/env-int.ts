/**
 * Strict integer parsing for environment-supplied numeric settings.
 *
 * `parseInt` accepts a numeric prefix, so `parseInt("25000junk", 10)` is 25000
 * and `parseInt("abc", 10)` is `NaN`. Neither outcome is safe for a budget, a
 * quota, or a threshold: the first silently becomes a different value than the
 * operator wrote, and the second poisons every subsequent comparison, because
 * every relational test against `NaN` is false. A limit that is `NaN` does not
 * fail loudly — it stops applying.
 *
 * Callers therefore share one parse that fails closed to the caller's fallback
 * for anything non-canonical. This module holds no configuration of its own so
 * that repositories, services, and caches can depend on the parse without
 * depending on a particular subsystem's config module.
 */

/**
 * Parse a canonical non-negative integer, falling back for empty, unset, or
 * non-canonical input. Values keeping a `+` sign prefix are accepted; anything
 * with trailing characters, a decimal point, or a leading `-` uses `fallback`.
 */
export function envInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  return /^\+?\d+$/.test(trimmed) ? Number(trimmed) : fallback;
}
