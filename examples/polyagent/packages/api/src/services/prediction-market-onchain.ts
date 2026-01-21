/**
 * On-Chain Prediction Market Service
 *
 * @description Handles on-chain prediction market transactions using Base Sepolia
 * testnet ETH. Interacts with the PredictionMarketFacet through a Diamond proxy
 * pattern for buying and selling shares in prediction markets.
 */

import { getContractAddresses, getRpcUrl } from "@polyagent/contracts";
import { CHAIN, logger } from "@polyagent/shared";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BadRequestError } from "../errors";

// Get contract addresses for current network
const { diamond: DIAMOND_ADDRESS } = getContractAddresses();

// Prediction Market Facet ABI (minimal for buy/sell)
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
    name: "getMarket",
    inputs: [{ name: "_marketId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "question", type: "string" },
          { name: "numOutcomes", type: "uint8" },
          { name: "liquidity", type: "uint256" },
          { name: "createdAt", type: "uint256" },
          { name: "resolveAt", type: "uint256" },
          { name: "resolved", type: "bool" },
          { name: "winningOutcome", type: "uint8" },
          { name: "oracle", type: "address" },
          { name: "totalVolume", type: "uint256" },
          { name: "feeRate", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPosition",
    inputs: [
      { name: "_user", type: "address" },
      { name: "_marketId", type: "bytes32" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "totalInvested", type: "uint256" },
          { name: "claimed", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
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

export class OnChainPredictionMarketService {
  private publicClient;
  private rpcUrl: string;

  constructor(rpcUrl?: string) {
    this.rpcUrl = rpcUrl || getRpcUrl();

    this.publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(this.rpcUrl),
    });
  }

  /**
   * Buy shares on-chain with user's wallet
   *
   * @param marketId - Market identifier (bytes32)
   * @param outcome - 0 for NO, 1 for YES
   * @param numShares - Number of shares to buy
   * @param userWalletClient - User's wallet client from Privy
   * @returns Transaction hash
   */
  async buyShares(
    marketId: string,
    outcome: "YES" | "NO",
    numShares: number,
    userWalletClient: WalletClient,
  ): Promise<{ txHash: string; sharesBought: number }> {
    if (!userWalletClient.account) {
      throw new BadRequestError("Wallet client must have an account");
    }

    const outcomeIndex = outcome === "YES" ? 1 : 0;

    // First calculate cost
    const cost = (await this.publicClient.readContract({
      address: DIAMOND_ADDRESS,
      abi: PREDICTION_MARKET_ABI,
      functionName: "calculateCost",
      args: [
        marketId as `0x${string}`,
        outcomeIndex,
        BigInt(Math.floor(numShares * 1e18)),
      ],
    })) as bigint;

    logger.info("Calculated on-chain cost", {
      marketId,
      outcome,
      numShares,
      cost: cost.toString(),
    });

    // Execute buy transaction
    const hash = await userWalletClient.writeContract({
      address: DIAMOND_ADDRESS,
      abi: PREDICTION_MARKET_ABI,
      functionName: "buyShares",
      args: [
        marketId as `0x${string}`,
        outcomeIndex,
        BigInt(Math.floor(numShares * 1e18)),
      ],
      chain: CHAIN,
      account: userWalletClient.account,
    });

    // Wait for confirmation
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });

    logger.info("Shares purchased on-chain", {
      marketId,
      outcome,
      txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
    });

    return {
      txHash: receipt.transactionHash,
      sharesBought: numShares,
    };
  }

  /**
   * Sell shares on-chain with user's wallet
   */
  async sellShares(
    marketId: string,
    outcome: "YES" | "NO",
    numShares: number,
    userWalletClient: WalletClient,
  ): Promise<{ txHash: string; sharesSold: number }> {
    if (!userWalletClient.account) {
      throw new BadRequestError("Wallet client must have an account");
    }

    const outcomeIndex = outcome === "YES" ? 1 : 0;

    // Execute sell transaction
    const hash = await userWalletClient.writeContract({
      address: DIAMOND_ADDRESS,
      abi: PREDICTION_MARKET_ABI,
      functionName: "sellShares",
      args: [
        marketId as `0x${string}`,
        outcomeIndex,
        BigInt(Math.floor(numShares * 1e18)),
      ],
      chain: CHAIN,
      account: userWalletClient.account,
    });

    // Wait for confirmation
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });

    logger.info("Shares sold on-chain", {
      marketId,
      outcome,
      txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
    });

    return {
      txHash: receipt.transactionHash,
      sharesSold: numShares,
    };
  }

  /**
   * Get market data from blockchain
   */
  async getMarket(marketId: string) {
    const market = await this.publicClient.readContract({
      address: DIAMOND_ADDRESS,
      abi: PREDICTION_MARKET_ABI,
      functionName: "getMarket",
      args: [marketId as `0x${string}`],
    });

    return market;
  }

  /**
   * Get user's position from blockchain
   */
  async getPosition(userAddress: Address, marketId: string) {
    const position = await this.publicClient.readContract({
      address: DIAMOND_ADDRESS,
      abi: PREDICTION_MARKET_ABI,
      functionName: "getPosition",
      args: [userAddress, marketId as `0x${string}`],
    });

    return position;
  }

  /**
   * Create wallet client from private key (for backend operations)
   */
  static createBackendWalletClient(
    privateKey: string,
    rpcUrl?: string,
  ): WalletClient {
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    return createWalletClient({
      account,
      chain: CHAIN,
      transport: http(rpcUrl || getRpcUrl()),
    });
  }
}

/**
 * Singleton instance for reuse
 */
let instance: OnChainPredictionMarketService | null = null;

export function getOnChainPredictionMarketService(): OnChainPredictionMarketService {
  if (!instance) {
    instance = new OnChainPredictionMarketService();
  }
  return instance;
}
