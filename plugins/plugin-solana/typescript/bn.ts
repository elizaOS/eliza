// Import BigNumber from bignumber.js using require to avoid circular import issues
const BigNumberLib = require("bignumber.js");

// Export as BN (not a re-export, this is a local binding)
export const BN = BigNumberLib;

// Export as default
export default BigNumberLib;

// Export type using a type-only import
export type BigNumber = typeof BigNumberLib;

// Import type for internal use
import type { default as BigNumberType } from "bignumber.js";

// Helper function to create new BigNumber instances
/**
 * Convert a string, number, or BigNumber to a BigNumber object.
 *
 * @param value - The value to convert to a BigNumber.
 * @returns A BigNumber object representing the input value.
 */
export function toBN(value: string | number | BigNumberType): BigNumberType {
  return new BigNumberLib(value);
}
