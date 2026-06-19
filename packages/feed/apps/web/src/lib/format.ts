/**
 * Web app currency formatting helpers.
 * Centralizes NaN handling and shared-format calls so components don't repeat wrappers.
 */

import {
  formatCompactCurrency,
  formatCurrency as formatCurrencyShared,
} from "@feed/shared";

export type CurrencyInput = string | number | null | undefined;

function toNumber(value: CurrencyInput): number {
  if (value == null) return 0;
  const num = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(num) ? num : 0;
}

/**
 * Full-precision display with thousands separator (e.g. $1,234.56).
 * Use for PnL cards, admin tables, and detailed amounts.
 */
export function formatCurrencyDisplay(value: CurrencyInput): string {
  return formatCurrencyShared(toNumber(value), { useThousandsSeparator: true });
}

/**
 * Compact K/M/B display (e.g. $1.50K, $2.30M).
 * Use for feeds, trade cards, and summary stats.
 */
export function formatCurrencyCompact(value: CurrencyInput): string {
  return formatCompactCurrency(toNumber(value));
}

/**
 * Default precision, no thousands separator (e.g. $1234.56).
 * Use when compact or thousands display is not needed.
 */
export function formatCurrencyDefault(value: CurrencyInput): string {
  return formatCurrencyShared(toNumber(value));
}
