import { BigNumber, Wallet } from "ethers";

// Constants
export const ETHER = BigNumber.from(10).pow(18);
export const DEFAULT_GAS_LIMIT = 250000;

// Math utilities
export function bigNumberToDecimal(value: BigNumber, base = 18): number {
    const divisor = BigNumber.from(10).pow(base);
    return value.mul(10000).div(divisor).toNumber() / 10000;
}

// Authentication utilities
export const getDefaultRelaySigningKey = (): string => {
    console.warn(
        "No FLASHBOTS_RELAY_SIGNING_KEY specified. Creating temporary key..."
    );
    return Wallet.createRandom().privateKey;
};

// Add error handling utilities
export const handleArbitrageError = (error: Error): void => {
    console.error(`Arbitrage Error: ${error.message}`);
    // Add any specific error handling logic
};