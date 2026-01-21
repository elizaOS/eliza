import { getContractAddresses } from "@polyagent/contracts";
import { CHAIN, logger } from "@polyagent/shared";
import { useCallback, useState } from "react";
import { encodeFunctionData, pad } from "viem";
import { useSmartWallet } from "@/hooks/useSmartWallet";

/**
 * Result of an on-chain betting transaction.
 */
export interface OnChainBetResult {
  /** Transaction hash */
  txHash: string;
  /** Number of shares purchased/sold */
  shares: number;
  /** Gas used (if available) */
  gasUsed?: string;
}

/**
 * Convert market ID (Snowflake ID string) to bytes32.
 * Preserves the numeric value by converting to hex and padding.
 */
function marketIdToBytes32(marketId: string): `0x${string}` {
  // Convert string number to BigInt, then to hex, then pad to 32 bytes
  const bigintValue = BigInt(marketId);
  const hexValue = `0x${bigintValue.toString(16)}` as `0x${string}`;
  return pad(hexValue, { size: 32 });
}

// Get contract addresses for current network (localnet or testnet/mainnet)
const { diamond: DIAMOND_ADDRESS, network: NETWORK } = getContractAddresses();

// Prediction Market Facet ABI
const PREDICTION_MARKET_ABI = [
  {
    type: "function",
    name: "buyShares",
    inputs: [
      { name: "_marketId", type: "bytes32" },
      { name: "_outcome", type: "uint8" },
      { name: "_numShares", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sellShares",
    inputs: [
      { name: "_marketId", type: "bytes32" },
      { name: "_outcome", type: "uint8" },
      { name: "_numShares", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "calculateCost",
    inputs: [
      { name: "_marketId", type: "bytes32" },
      { name: "_outcome", type: "uint8" },
      { name: "_numShares", type: "uint256" },
    ],
    outputs: [{ name: "cost", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/**
 * Hook for on-chain prediction market betting with Base Sepolia ETH.
 *
 * Enables users to buy and sell shares in prediction markets using their
 * smart wallet. Transactions execute on the Base Sepolia blockchain through
 * the prediction market diamond contract. Supports gasless transactions when
 * using an embedded wallet.
 *
 * @returns An object containing:
 * - `buyShares`: Function to buy shares for a prediction market
 * - `sellShares`: Function to sell shares for a prediction market
 * - `loading`: Whether a transaction is currently in progress
 * - `error`: Any error that occurred during the transaction
 * - `smartWalletReady`: Whether the smart wallet is ready for transactions
 *
 * @example
 * ```tsx
 * const { buyShares, loading, error } = useOnChainBetting();
 *
 * const handleBuy = async () => {
 *   try {
 *     const result = await buyShares(marketId, 'YES', 10);
 *     console.log('Transaction:', result.txHash);
 *   } catch (err) {
 *     console.error('Buy failed:', err);
 *   }
 * };
 * ```
 */
export function useOnChainBetting() {
  const { client, smartWalletReady, sendSmartWalletTransaction } =
    useSmartWallet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Buy shares on-chain with smart wallet.
   *
   * @param marketId - The Snowflake ID of the prediction market
   * @param outcome - Whether to buy 'YES' or 'NO' shares
   * @param numShares - Number of shares to buy (will be converted to wei)
   * @returns Promise resolving to transaction result with txHash and shares
   * @throws Error if smart wallet is not ready or transaction fails
   */
  const buyShares = useCallback(
    async (
      marketId: string,
      outcome: "YES" | "NO",
      numShares: number,
    ): Promise<OnChainBetResult> => {
      if (!smartWalletReady || !client) {
        throw new Error("Smart wallet not ready. Please connect your wallet.");
      }

      setLoading(true);
      setError(null);

      const outcomeIndex = outcome === "YES" ? 1 : 0;
      const sharesBigInt = BigInt(Math.floor(numShares * 1e18));

      // Convert Snowflake ID to bytes32
      const marketIdBytes32 = marketIdToBytes32(marketId);

      logger.info("Buying shares on-chain", {
        network: NETWORK,
        diamond: DIAMOND_ADDRESS,
        marketId,
        marketIdBytes32,
        outcome,
        numShares,
        outcomeIndex,
      });

      // Encode the function call
      const data = encodeFunctionData({
        abi: PREDICTION_MARKET_ABI,
        functionName: "buyShares",
        args: [marketIdBytes32, outcomeIndex, sharesBigInt],
      });

      // Send transaction via smart wallet
      const hash = await sendSmartWalletTransaction({
        to: DIAMOND_ADDRESS,
        data,
        chain: CHAIN,
      });

      logger.info("Buy shares transaction sent", {
        marketId,
        outcome,
        txHash: hash,
      });

      setLoading(false);
      return {
        txHash: hash,
        shares: numShares,
      };
    },
    [smartWalletReady, client, sendSmartWalletTransaction],
  );

  /**
   * Sell shares on-chain with smart wallet.
   *
   * @param marketId - The Snowflake ID of the prediction market
   * @param outcome - Whether to sell 'YES' or 'NO' shares
   * @param numShares - Number of shares to sell (will be converted to wei)
   * @returns Promise resolving to transaction result with txHash and shares
   * @throws Error if smart wallet is not ready or transaction fails
   */
  const sellShares = useCallback(
    async (
      marketId: string,
      outcome: "YES" | "NO",
      numShares: number,
    ): Promise<OnChainBetResult> => {
      if (!smartWalletReady || !client) {
        throw new Error("Smart wallet not ready. Please connect your wallet.");
      }

      setLoading(true);
      setError(null);

      const outcomeIndex = outcome === "YES" ? 1 : 0;
      const sharesBigInt = BigInt(Math.floor(numShares * 1e18));

      // Convert Snowflake ID to bytes32
      const marketIdBytes32 = marketIdToBytes32(marketId);

      logger.info("Selling shares on-chain", {
        marketId,
        marketIdBytes32,
        outcome,
        numShares,
      });

      // Encode the function call
      const data = encodeFunctionData({
        abi: PREDICTION_MARKET_ABI,
        functionName: "sellShares",
        args: [marketIdBytes32, outcomeIndex, sharesBigInt],
      });

      // Send transaction via smart wallet
      const hash = await sendSmartWalletTransaction({
        to: DIAMOND_ADDRESS,
        data,
        chain: CHAIN,
      });

      logger.info("Sell shares transaction sent", {
        marketId,
        outcome,
        txHash: hash,
      });

      setLoading(false);
      return {
        txHash: hash,
        shares: numShares,
      };
    },
    [smartWalletReady, client, sendSmartWalletTransaction],
  );

  return {
    buyShares,
    sellShares,
    loading,
    error,
    smartWalletReady,
  };
}
