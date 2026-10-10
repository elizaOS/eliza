import { parseUnits } from "viem";

/**
 * Parse a user-confirmed decimal amount into base units with `decimals`
 * places. viem's parseUnits rounds digits past `decimals` half-up, so a
 * confirmed "1.0000005" of a 6-decimal token signed 1.000001; precision the
 * token cannot hold is an error here, not a different transfer. Trailing zeros
 * past `decimals` are fine.
 */
export function parseExactUnits(amount: string, decimals: number): bigint {
  const fraction = amount.split(".")[1] ?? "";
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(
      `Amount ${amount} has more than ${decimals} decimal places for this token.`,
    );
  }
  return parseUnits(amount, decimals);
}

/** parseExactUnits for a native 18-decimal amount (parseEther rounds too). */
export function parseExactEther(amount: string): bigint {
  return parseExactUnits(amount, 18);
}
