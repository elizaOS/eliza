/**
 * Utility functions for formatting values in the Polygon plugin
 */

import { formatUnits as viemFormatUnits, parseUnits as viemParseUnits } from 'viem';

/**
 * Formats a wei amount to a human-readable string with the specified number of decimals
 * 
 * @param amount Amount in wei (as bigint or string)
 * @param decimals Number of decimals to format with (default: 18 for ETH/MATIC)
 * @param displayDecimals Number of decimal places to display (default: 4)
 * @returns Formatted string with the specified number of decimals
 */
export function formatUnits(amount: bigint | string, decimals: number = 18, displayDecimals: number = 4): string {
  const amountBigInt = typeof amount === 'string' ? BigInt(amount) : amount;
  const formatted = viemFormatUnits(amountBigInt, decimals);
  
  // If display decimals is specified, format to that precision
  if (displayDecimals >= 0) {
    const parts = formatted.split('.');
    if (parts.length === 1) return parts[0];
    return `${parts[0]}.${parts[1].substring(0, displayDecimals)}`;
  }
  
  return formatted;
}

/**
 * Parses a human-readable amount string to wei
 * 
 * @param amount Amount as a string (e.g., "1.5")
 * @param decimals Number of decimals to parse with (default: 18 for ETH/MATIC)
 * @returns Amount in wei as a bigint
 */
export function parseUnits(amount: string, decimals: number = 18): bigint {
  return viemParseUnits(amount, decimals);
}

/**
 * Formats a wei amount to a human-readable string with appropriate units
 * 
 * @param weiAmount Amount in wei as bigint
 * @param decimals Number of decimals (default: 18 for ETH/MATIC)
 * @param symbol Token symbol to append (optional)
 * @returns Formatted string with appropriate units
 */
export function formatWei(weiAmount: bigint, decimals: number = 18, symbol?: string): string {
  const formatted = formatUnits(weiAmount, decimals);
  return symbol ? `${formatted} ${symbol}` : formatted;
}

/**
 * Formats a gas price from wei to gwei
 * 
 * @param weiAmount Gas price in wei
 * @returns Formatted gas price in gwei
 */
export function formatGasPrice(weiAmount: bigint): string {
  return formatUnits(weiAmount, 9, 2) + ' gwei';
}

/**
 * Formats a timestamp to a human-readable date string
 * 
 * @param timestamp Unix timestamp in seconds
 * @returns Formatted date string
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Truncates an address for display purposes
 * 
 * @param address Full Ethereum/Polygon address
 * @param startChars Number of characters to show at the start
 * @param endChars Number of characters to show at the end
 * @returns Truncated address
 */
export function truncateAddress(address: string, startChars: number = 6, endChars: number = 4): string {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  
  return `${address.substring(0, startChars)}...${address.substring(address.length - endChars)}`;
}

/**
 * Formats a number with thousands separators
 * 
 * @param num Number to format
 * @returns Formatted number with thousands separators
 */
export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

/**
 * Formats a token balance with symbol and proper units
 * 
 * @param balance - The BigInt token balance
 * @param decimals - Number of decimal places
 * @param symbol - Token symbol to append (e.g., "MATIC")
 * @returns Formatted balance string with symbol
 */
export function formatTokenBalance(balance: bigint, decimals: number, symbol: string): string {
  const formatted = formatUnits(balance, decimals);
  return `${formatted} ${symbol}`;
}

/**
 * Parse address string to normalized format with 0x prefix
 * 
 * @param address - Address string, with or without 0x prefix
 * @returns Normalized address with 0x prefix
 */
export function normalizeAddress(address: string): `0x${string}` {
  if (!address) throw new Error('Address cannot be empty');
  
  // Add 0x prefix if missing
  if (!address.startsWith('0x')) {
    return `0x${address}` as `0x${string}`;
  }
  
  return address as `0x${string}`;
} 