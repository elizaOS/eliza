/**
 * @module tokens/decimals
 * Token decimal normalization utilities for multi-token agent wallets.
 *
 * Handles safe conversion between human-readable amounts ("1.5") and raw
 * on-chain bigint amounts (1500000n for USDC with 6 decimals). All arithmetic
 * is done in integer domain to avoid floating point precision errors.
 */

import type { Address } from "viem";

/** Minimal token info required for formatting */
export interface TokenInfo {
  symbol: string;
  decimals: number;
  address: Address;
  name?: string;
  chainId?: number;
}

/**
 * Convert a human-readable amount string to raw bigint (on-chain units).
 *
 * @param amount - Human-readable amount, e.g. "1.5" or "1000"
 * @param decimals - Token decimal places (e.g. 6 for USDC, 18 for WETH)
 * @returns Raw on-chain amount as bigint
 *
 * @example
 * toRaw("1.5", 6)   // → 1500000n  (1.5 USDC)
 * toRaw("1.0", 18)  // → 1000000000000000000n  (1 WETH)
 * toRaw("0.001", 8) // → 100000n  (0.001 WBTC)
 */
export function toRaw(amount: string | bigint, decimals: number): bigint {
  if (typeof amount === "bigint") return amount;

  const str = amount.trim();
  if (!str || str === "0") return 0n;

  // Validate: only digits and one optional decimal point, optional leading minus
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`toRaw: invalid amount string "${amount}"`);
  }

  const negative = str.startsWith("-");
  const abs = negative ? str.slice(1) : str;

  const dotIndex = abs.indexOf(".");
  if (dotIndex === -1) {
    // Integer amount
    const result = BigInt(abs) * 10n ** BigInt(decimals);
    return negative ? -result : result;
  }

  const intPart = abs.slice(0, dotIndex);
  let fracPart = abs.slice(dotIndex + 1);

  // Truncate or pad fractional part to `decimals` digits
  if (fracPart.length > decimals) {
    fracPart = fracPart.slice(0, decimals); // truncate (floor for positive amounts)
  } else {
    fracPart = fracPart.padEnd(decimals, "0");
  }

  const raw =
    BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(fracPart);

  return negative ? -raw : raw;
}

/**
 * Convert a raw bigint on-chain amount to a human-readable string.
 *
 * @param amount - Raw on-chain amount
 * @param decimals - Token decimal places
 * @returns Human-readable string, trimmed trailing zeros
 *
 * @example
 * toHuman(1500000n, 6)               // → "1.5"
 * toHuman(1000000000000000000n, 18)  // → "1.0"
 * toHuman(0n, 6)                     // → "0.0"
 */
export function toHuman(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();

  const negative = amount < 0n;
  const abs = negative ? -amount : amount;

  const divisor = 10n ** BigInt(decimals);
  const intPart = abs / divisor;
  const fracRaw = abs % divisor;

  // Pad fractional part to `decimals` digits
  const fracStr = fracRaw.toString().padStart(decimals, "0");

  // Trim trailing zeros but keep at least one decimal digit
  const trimmed = fracStr.replace(/0+$/, "") || "0";

  const result = `${intPart}.${trimmed}`;
  return negative ? `-${result}` : result;
}

/**
 * Format a raw bigint amount with token symbol for display.
 *
 * @param amount - Raw on-chain amount
 * @param token - Token info (symbol + decimals required)
 * @param displayDecimals - Max decimal places to show (default: 4 for high-precision, 2 for stablecoins)
 * @returns Formatted string e.g. "1.50 USDC" or "0.0023 WETH"
 *
 * @example
 * formatBalance(1500000n, { symbol: 'USDC', decimals: 6, address: '0x...' })
 * // → "1.50 USDC"
 */
export function formatBalance(
  amount: bigint,
  token: Pick<TokenInfo, "symbol" | "decimals">,
  displayDecimals?: number,
): string {
  const human = toHuman(amount, token.decimals);
  const maxDisplay = displayDecimals ?? (token.decimals <= 6 ? 2 : 4);

  // Parse the human string and reformat to maxDisplay decimal places
  const [intPart, fracPart = ""] = human.split(".");
  const padded = fracPart.padEnd(maxDisplay, "0").slice(0, maxDisplay);

  // If all fraction digits are zero, still show them for consistent formatting
  return `${intPart}.${padded} ${token.symbol}`;
}

/**
 * Parse amount that may be either a string (human-readable) or bigint (raw).
 * Returns raw bigint. Used in transfer functions to accept flexible input.
 *
 * @param amount - Either a human-readable string "1.5" or a raw bigint
 * @param decimals - Required only when amount is a string
 */
export function parseAmount(amount: string | bigint, decimals: number): bigint {
  if (typeof amount === "bigint") return amount;
  return toRaw(amount, decimals);
}
