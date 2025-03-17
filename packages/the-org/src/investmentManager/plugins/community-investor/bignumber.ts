import BigNumber from 'bignumber.js';

// Re-export BigNumber constructor
export const BN = BigNumber;

// Helper function to create new BigNumber instances
/**
 * Converts the input value to a BigNumber.
 * @param {string | number | BigNumber} value - The value to convert to a BigNumber.
 * @returns {BigNumber} The BigNumber representation of the input value.
 */
export function toBN(value: string | number | BigNumber): BigNumber {
  return new BigNumber(value);
}
