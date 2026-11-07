import { ElizaError } from "@elizaos/core";
import BigNumber from "./bn";

const SOLANA_TOKEN_BASE_UNIT_MAX = new BigNumber("18446744073709551615");

export const SOLANA_TOKEN_TRANSFER_AMOUNT_INVALID = {
  code: "SOLANA_TOKEN_TRANSFER_AMOUNT_INVALID",
  subject: "SPL token transfer amount",
} as const;

export const SOLANA_SWAP_AMOUNT_INVALID = {
  code: "SOLANA_SWAP_AMOUNT_INVALID",
  subject: "Solana swap input amount",
} as const;

/**
 * Converts a human token amount into integer base units. A fractional base
 * unit is rejected. Rounding it would ask a transfer or quote to move more
 * tokens than the caller named.
 */
export function parseSolanaTokenBaseUnits(
  amount: string | undefined,
  decimals: number,
  invalid: {
    code: string;
    subject: string;
  } = SOLANA_TOKEN_TRANSFER_AMOUNT_INVALID
): bigint {
  let baseUnits: InstanceType<typeof BigNumber>;
  try {
    baseUnits = new BigNumber(amount ?? "0").multipliedBy(new BigNumber(10).pow(decimals));
  } catch (cause) {
    // error-policy:J2 Preserve malformed decimal input as a typed validation failure.
    throw new ElizaError(`${invalid.subject} is not a valid decimal value.`, {
      code: invalid.code,
      cause,
    });
  }
  if (
    !baseUnits.isFinite() ||
    baseUnits.lte(0) ||
    !baseUnits.isInteger() ||
    baseUnits.gt(SOLANA_TOKEN_BASE_UNIT_MAX)
  ) {
    throw new ElizaError(
      `${invalid.subject} must be a positive finite value exactly representable as an integer number of base units.`,
      { code: invalid.code }
    );
  }
  return BigInt(baseUnits.toFixed(0));
}
