import { ElizaError } from "@elizaos/core";
import { parseUnits } from "viem";

/**
 * Convert a decimal amount string into base units with `decimals` places.
 * viem's `parseUnits` rounds digits past `decimals` half-up, so a confirmed
 * "1.0000005" of a 6-decimal token would sign 1.000001. Precision the token
 * cannot hold is an error, not a different transfer. Zeros past `decimals`
 * name the same amount and are accepted.
 */
export function parseEvmBaseUnits(amount: string, decimals: number): bigint {
  const fraction = amount.split(".")[1] ?? "";
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new ElizaError(
      `Amount ${amount} must be exactly representable in ${decimals} decimal places.`,
      { code: "EVM_AMOUNT_NOT_REPRESENTABLE" },
    );
  }
  return parseUnits(amount, decimals);
}
