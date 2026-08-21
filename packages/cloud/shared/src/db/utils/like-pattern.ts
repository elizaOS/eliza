/**
 * Shared LIKE/ILIKE pattern escaping for repository search filters.
 *
 * User-supplied search text is always bound as a parameter (no SQL injection),
 * but unescaped `%`/`_` still act as wildcards — a search term would match far
 * more rows than its literal text intends. Escape the LIKE metacharacters so
 * the pattern matches the literal substring. Postgres' default LIKE escape
 * character is the backslash, so escaped patterns work with drizzle's
 * `ilike()`; raw-SQL sites should spell `ESCAPE '\'` out explicitly.
 */

/**
 * Escapes special LIKE pattern characters to prevent pattern injection.
 * Characters %, _, and \ have special meaning in SQL LIKE patterns.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}
