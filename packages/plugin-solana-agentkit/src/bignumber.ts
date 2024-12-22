import BigNumber from "bignumber.js";

// Re-export BigNumber constructor
export const BN = BigNumber;

// Helper function to create new BigNumber instances
export function toBN(value: string | number | BigNumber): BigNumber {
    return new BigNumber(value);
}
