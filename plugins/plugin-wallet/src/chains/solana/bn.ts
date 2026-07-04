/** Re-exports `bignumber.js` as the shared arbitrary-precision type for Solana token/lamport math. */
import type { default as BigNumberType } from "bignumber.js";
import BigNumberLib from "bignumber.js";

export const BN = BigNumberLib;
export default BigNumberLib;
export type BigNumber = typeof BigNumberLib;

export function toBN(value: string | number | BigNumberType): BigNumberType {
  return new BigNumberLib(value);
}
