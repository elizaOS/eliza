/**
 * Currency constants for Babylon points system
 *
 * Babylon uses a custom points currency system represented by ƀ (B with stroke)
 * NOT to be confused with USD ($) or Bitcoin (₿)
 */

/**
 * Symbol used for displaying Babylon points in the UI
 * Configurable via NEXT_PUBLIC_CURRENCY_SYMBOL environment variable
 *
 * Default: ƀ (U+0255) - Latin Small Letter B with Stroke
 * Chosen for its horizontal stroke through B, giving a distinct Babylon identity
 */
export const BABYLON_POINTS_SYMBOL =
  process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || 'ƀ';

/**
 * Abbreviated text representation for Babylon points
 * Used in labels, form fields, and contexts where the symbol may not render properly
 */
export const BABYLON_POINTS_ABBREV = 'PTS';

/**
 * Full name for the currency
 */
export const BABYLON_POINTS_NAME = 'Babylon Points';
