/**
 * Currency constants for Feed points system
 *
 * Feed Points use a display symbol (default `$`) that is **not** USD — amounts
 * are in-game points. Bitcoin (₿) and other symbols remain available via env.
 */

/**
 * Symbol used for displaying Feed points in the UI
 * Configurable via NEXT_PUBLIC_CURRENCY_SYMBOL environment variable
 *
 * Default: `$` (ASCII dollar sign). Override if you need a distinct glyph.
 */
export const FEED_POINTS_SYMBOL =
  process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || "$";

/**
 * Abbreviated text representation for Feed points
 * Used in labels, form fields, and contexts where the symbol may not render properly
 */
export const FEED_POINTS_ABBREV = "PTS";

/**
 * Full name for the currency
 */
export const FEED_POINTS_NAME = "Feed Points";
