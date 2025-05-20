import BigNumber from 'bignumber.js';

// Re-export BigNumber constructor
export const BN = BigNumber;

// Helper function to create new BigNumber instances
/**
 * Convert a string, number, or BigNumber to a BigNumber object.
 *
 * @param value - The value to convert to a BigNumber.
 * @returns A BigNumber object representing the input value.
 */

export function toBN(value: string | number | BigNumber): BigNumber {
  return new BigNumber(value);
}
