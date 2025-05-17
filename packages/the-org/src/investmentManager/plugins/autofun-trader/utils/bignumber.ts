import BigNumber from 'bignumber.js';

// Configure BigNumber settings
BigNumber.config({
  DECIMAL_PLACES: 18,
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
  EXPONENTIAL_AT: [-20, 20],
});

/**
 * Creates a new BigNumber instance with proper error handling
 */
export function toBN(value: string | number | BigNumber): BigNumber {
  try {
    return new BigNumber(value);
  } catch (error) {
    throw new Error(`Failed to convert value to BigNumber: ${value}`);
  }
}

/**
 * Formats a BigNumber to a human readable string
 */
export function formatBN(value: BigNumber, decimals = 18): string {
  try {
    return value.dividedBy(new BigNumber(10).pow(decimals)).toFixed();
  } catch (error) {
    throw new Error(`Failed to format BigNumber: ${value}`);
  }
}

export { BigNumber as BN };
