/**
 * Wallet display helpers: block-explorer transaction URLs for the active chain and
 * fixed-point formatting of raw token balances for the UI.
 */
import { getCurrentChainId } from "../config";

/**
 * Returns an Etherscan/Basescan explorer URL for a given transaction hash.
 * Covers all chains supported by the platform.
 */
export function getTxExplorerUrl(txHash: string): string {
  switch (getCurrentChainId()) {
    case 1:
      return `https://etherscan.io/tx/${txHash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    case 84532:
      return `https://sepolia.basescan.org/tx/${txHash}`;
    default:
      return "";
  }
}

/**
 * Format a raw wei/unit token balance for display.
 *
 * @param rawBalance - The raw integer balance as a string (in smallest unit)
 * @param decimals   - Token decimals (e.g. 18 for ETH, 6 for USDC)
 * @param maxDecimals - Maximum fractional digits to display (default: 6)
 *
 * @example
 * formatTokenBalance('1500000', 6)     // → '1.5'   (USDC)
 * formatTokenBalance('1000000000000000000', 18) // → '1'  (1 ETH)
 * formatTokenBalance('1234567890000000000', 18, 4) // → '1.2345'
 */
export function formatTokenBalance(
  rawBalance: string,
  decimals: number,
  maxDecimals = 6,
): string {
  const raw = BigInt(rawBalance);
  if (raw === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const remainderStr = remainder.toString().padStart(decimals, "0");
  const trimmed = remainderStr.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}
