import { createRequire } from "node:module";
import type { default as BigNumberType } from "bignumber.js";

const require = createRequire(import.meta.url);
const BigNumberLib = require("bignumber.js") as typeof BigNumberType;

export const BN = BigNumberLib;
export default BigNumberLib;
export type BigNumber = typeof BigNumberLib;

export function toBN(value: string | number | BigNumberType): BigNumberType {
  return new BigNumberLib(value);
}
