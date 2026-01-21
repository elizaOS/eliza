/**
 * Currency constants for Polyagent points system
 *
 * Polyagent uses a custom points currency system represented by ƀ (B with stroke)
 * NOT to be confused with USD ($) or Bitcoin (₿)
 */

/**
 * Symbol used for displaying Polyagent points in the UI
 * Configurable via NEXT_PUBLIC_CURRENCY_SYMBOL environment variable
 *
 * Default: ƀ (U+0255) - Latin Small Letter B with Stroke
 * Chosen for its horizontal stroke through B, giving a distinct Polyagent identity
 */
export const POLYAGENT_POINTS_SYMBOL =
  process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || "ƀ";

/**
 * Abbreviated text representation for Polyagent points
 * Used in labels, form fields, and contexts where the symbol may not render properly
 */
export const POLYAGENT_POINTS_ABBREV = "PTS";

/**
 * Full name for the currency
 */
export const POLYAGENT_POINTS_NAME = "Polyagent Points";
