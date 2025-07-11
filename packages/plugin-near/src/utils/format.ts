import BigNumber from 'bignumber.js';
import { utils } from 'near-api-js';
import { NEAR_DECIMALS } from '../core/constants';

/**
 * Format token amount from raw to human readable
 */
export function formatTokenAmount(
  amount: string | number | BigNumber,
  decimals: number,
  precision: number = 6
): string {
  const bn = new BigNumber(amount.toString());
  const divisor = new BigNumber(10).pow(decimals);
  const result = bn.div(divisor);

  // Remove trailing zeros
  return result.toFixed(precision).replace(/\.?0+$/, '');
}

/**
 * Parse token amount from human readable to raw
 */
export function parseTokenAmount(amount: string | number, decimals: number): string {
  const bn = new BigNumber(amount.toString());
  const multiplier = new BigNumber(10).pow(decimals);
  return bn.times(multiplier).toFixed(0);
}

/**
 * Format NEAR amount from yoctoNEAR
 */
export function formatNearAmount(yoctoAmount: string | number): string {
  return utils.format.formatNearAmount(yoctoAmount.toString());
}

/**
 * Parse NEAR amount to yoctoNEAR
 */
export function parseNearAmount(nearAmount: string | number): string | null {
  return utils.format.parseNearAmount(nearAmount.toString());
}

/**
 * Format USD value
 */
export function formatUsdValue(value: number, includeSymbol: boolean = true): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const formatted = formatter.format(value);
  return includeSymbol ? formatted : formatted.replace('$', '');
}

/**
 * Format percentage
 */
export function formatPercentage(value: number, precision: number = 2): string {
  return `${(value * 100).toFixed(precision)}%`;
}

/**
 * Format large numbers with abbreviations
 */
export function formatLargeNumber(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (num >= 1e9) {
    return `${(num / 1e9).toFixed(2)}B`;
  } else if (num >= 1e6) {
    return `${(num / 1e6).toFixed(2)}M`;
  } else if (num >= 1e3) {
    return `${(num / 1e3).toFixed(2)}K`;
  }

  return num.toFixed(2);
}

/**
 * Format time duration
 */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format gas amount
 */
export function formatGas(gas: string | number): string {
  const tGas = new BigNumber(gas.toString()).div(1e12);
  return `${tGas.toFixed(2)} TGas`;
}

/**
 * Truncate string in the middle
 */
export function truncateMiddle(
  str: string,
  startLength: number = 6,
  endLength: number = 4
): string {
  if (str.length <= startLength + endLength) {
    return str;
  }

  return `${str.slice(0, startLength)}...${str.slice(-endLength)}`;
}
