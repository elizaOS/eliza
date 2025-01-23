import { formatUnits, Hash } from "viem";
import { EVMTokenRegistry } from "./EVMtokenRegistry";
import { IAgentRuntime } from "@elizaos/core";

/**
 * Formats a token amount with its symbol
 * @param amount The amount in base units (e.g., wei)
 * @param address The token address
 * @param chainId The chain ID (defaults to 1 for Ethereum mainnet)
 * @returns Formatted string like "1.234567 USDC"
 */
export function formatTokenAmount(
    amount: string,
    address: string,
    chainId: number = 1
): string {
    if (!amount) return "0";

    const tokenRegistry = EVMTokenRegistry.getInstance();
    const token = tokenRegistry.getTokenByAddress(address, chainId);

    if (!token) throw new Error(`Token not found for address: ${address}`);

    const parsedAmount = formatUnits(BigInt(amount), token.decimals);
    return `${Number(parsedAmount).toFixed(4)} ${token.symbol}`;
}
