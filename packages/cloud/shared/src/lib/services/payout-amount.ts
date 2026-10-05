import { parseUnits } from "viem";

/**
 * Convert a payout amount to token base units exactly.
 *
 * Both payout paths must agree on this conversion. The Solana path used
 * `BigInt(Math.floor(Number(x) * 10 ** decimals))`: binary floating point
 * cannot represent most decimal amounts, so `0.125000283 * 1e9` is
 * `125000282.99999999` and `Math.floor` then broadcasts a transfer that is
 * **one base unit less** than the redemption the caller approved. `parseUnits`
 * converts the decimal string digit by digit and cannot drift.
 *
 * Callers must run the fail-closed `parseRedemptionAmount` gate first: this
 * helper converts what it is given and does not decide whether a payout should
 * happen.
 */
export function payoutAmountToBaseUnits(elizaAmount: unknown, decimals: number): bigint {
  return parseUnits(typeof elizaAmount === "string" ? elizaAmount : String(elizaAmount), decimals);
}
