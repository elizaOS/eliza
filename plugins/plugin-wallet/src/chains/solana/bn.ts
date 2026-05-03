const BigNumberLib = require("bignumber.js");

export const BN = BigNumberLib;
export default BigNumberLib;
export type BigNumber = typeof BigNumberLib;

import type { default as BigNumberType } from "bignumber.js";

export function toBN(value: string | number | BigNumberType): BigNumberType {
  return new BigNumberLib(value);
}
