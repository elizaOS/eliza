/**
 * Utility functions for formatting values in the Markets page.
 */

import { PredictionPricing } from '@feed/core/markets/prediction/client';
import { FEED_POINTS_SYMBOL } from '@feed/shared';

/**
 * Formats a price value as Feed points currency.
 *
 * @param price - The price to format
 * @returns Formatted price string (e.g., "$123.45")
 */
export function formatPrice(price: number): string {
  return `${FEED_POINTS_SYMBOL}${price.toFixed(2)}`;
}

/**
 * Formats a Feed points balance with 2 decimals and separators.
 *
 * @param balance - The balance to format
 * @returns Formatted balance string (e.g., "$12,345.00")
 */
export function formatBalance(balance: number): string {
  return `${FEED_POINTS_SYMBOL}${balance.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Formats a volume value with appropriate suffix (K, M, B).
 * Values under $1,000 are displayed without suffix.
 *
 * @param volume - The volume to format
 * @returns Formatted volume string (e.g., "$1.23M", "$500.00")
 */
export function formatVolume(volume: number): string {
  if (volume >= 1e9)
    return `${FEED_POINTS_SYMBOL}${(volume / 1e9).toFixed(2)}B`;
  if (volume >= 1e6)
    return `${FEED_POINTS_SYMBOL}${(volume / 1e6).toFixed(2)}M`;
  if (volume >= 1e3)
    return `${FEED_POINTS_SYMBOL}${(volume / 1e3).toFixed(2)}K`;
  return `${FEED_POINTS_SYMBOL}${volume.toFixed(2)}`;
}

/**
 * Calculates days remaining until a target date.
 *
 * @param date - ISO date string or undefined
 * @returns Number of days remaining, or null if no date provided
 */
export function getDaysLeft(date?: string): number | null {
  if (!date) return null;
  const diff = Math.ceil(
    (new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  return Math.max(0, diff);
}

/**
 * Calculates YES/NO percentages from share counts.
 *
 * Note: In our CPMM-style YES/NO markets, the displayed "probability" should
 * match the AMM price (not the raw share ratio). We therefore use
 * `PredictionPricing.getCurrentPrice()` as the source of truth.
 *
 * @param yesShares - Number of YES shares
 * @param noShares - Number of NO shares
 * @returns Object with yesPercent and noPercent
 */
export function calculateSharePercentages(
  yesShares: number | undefined,
  noShares: number | undefined
): { yesPercent: number; noPercent: number; totalShares: number } {
  const yes = yesShares ?? 0;
  const no = noShares ?? 0;
  const total = yes + no;

  if (total === 0) {
    return { yesPercent: 50, noPercent: 50, totalShares: 0 };
  }

  const yesPrice = PredictionPricing.getCurrentPrice(yes, no, 'yes');
  const noPrice = PredictionPricing.getCurrentPrice(yes, no, 'no');

  return {
    yesPercent: yesPrice * 100,
    noPercent: noPrice * 100,
    totalShares: total,
  };
}
