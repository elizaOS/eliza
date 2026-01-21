/**
 * Reputation Service
 *
 * @description Handles on-chain reputation updates based on prediction market
 * outcomes. Winners get +10 reputation, losers get -5 reputation.
 */

import { db, eq, inArray, positions, users } from "@polyagent/db";
import {
  getCurrentRpcUrl,
  logger,
  REPUTATION_SYSTEM_ABI,
  REPUTATION_SYSTEM_BASE_SEPOLIA,
} from "@polyagent/shared";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Contract addresses from canonical config
const REPUTATION_SYSTEM = REPUTATION_SYSTEM_BASE_SEPOLIA as Address;

// Hardhat default account #0 private key (has 10000 ETH on local node)
const HARDHAT_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

// Server wallet for paying gas - uses Hardhat's pre-funded account for local dev
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 31337);
const DEPLOYER_PRIVATE_KEY: `0x${string}` =
  chainId === 31337
    ? HARDHAT_DEFAULT_PRIVATE_KEY
    : (process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);

/**
 * Market resolution information
 */
interface MarketResolution {
  marketId: string;
  outcome: boolean; // true = YES, false = NO
}

/**
 * Reputation update result
 */
interface ReputationUpdate {
  userId: string;
  tokenId: number;
  change: number; // +10 or -5
  txHash?: string;
  error?: string;
}

/**
 * Reputation Service Class
 */
export class ReputationService {
  /**
   * Update reputation for all users who had positions in a resolved market
   */
  static async updateReputationForResolvedMarket(
    resolution: MarketResolution,
  ): Promise<ReputationUpdate[]> {
    const results: ReputationUpdate[] = [];

    // 1. Get all positions for this market
    const positionsData = await db
      .select({
        id: positions.id,
        userId: positions.userId,
        side: positions.side,
        shares: positions.shares,
      })
      .from(positions)
      .where(eq(positions.marketId, resolution.marketId));

    if (positionsData.length === 0) {
      logger.info(
        `No positions found for market ${resolution.marketId}`,
        undefined,
        "ReputationService",
      );
      return [];
    }

    // Get user data for all positions
    const userIds = [...new Set(positionsData.map((p) => p.userId))];
    const usersData = await db
      .select({
        id: users.id,
        nftTokenId: users.nftTokenId,
        onChainRegistered: users.onChainRegistered,
      })
      .from(users)
      .where(inArray(users.id, userIds));

    const userMap = new Map(usersData.map((u) => [u.id, u]));

    logger.info(
      `Updating reputation for ${positionsData.length} positions in market ${resolution.marketId}`,
      { count: positionsData.length, marketId: resolution.marketId },
      "ReputationService",
    );

    // 2. Create clients
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(getCurrentRpcUrl()),
    });

    const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(getCurrentRpcUrl()),
    });

    // 3. Process each position
    for (const position of positionsData) {
      const user = userMap.get(position.userId);

      // Skip if user is not registered on-chain
      if (!user?.onChainRegistered || !user.nftTokenId) {
        results.push({
          userId: position.userId,
          tokenId: 0,
          change: 0,
          error: "User not registered on-chain",
        });
        continue;
      }

      const tokenId = user.nftTokenId;
      const isWinner = position.side === resolution.outcome;
      const sharesAmount = Number(position.shares);
      const amount = parseEther(Math.abs(sharesAmount).toString());

      let txHash: `0x${string}`;

      if (isWinner) {
        // Winner: +10 reputation
        logger.info(
          `Recording WIN for token ${tokenId} (+10 reputation)`,
          { tokenId, change: 10 },
          "ReputationService",
        );
        txHash = await walletClient.writeContract({
          address: REPUTATION_SYSTEM,
          abi: parseAbi(REPUTATION_SYSTEM_ABI),
          functionName: "recordWin",
          args: [BigInt(tokenId), amount],
        });
      } else {
        // Loser: -5 reputation
        logger.info(
          `Recording LOSS for token ${tokenId} (-5 reputation)`,
          { tokenId, change: -5 },
          "ReputationService",
        );
        txHash = await walletClient.writeContract({
          address: REPUTATION_SYSTEM,
          abi: parseAbi(REPUTATION_SYSTEM_ABI),
          functionName: "recordLoss",
          args: [BigInt(tokenId), amount],
        });
      }

      // Wait for transaction confirmation
      await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      results.push({
        userId: position.userId,
        tokenId,
        change: isWinner ? 10 : -5,
        txHash,
      });

      logger.info(
        `Updated reputation for token ${tokenId}`,
        { tokenId, txHash, change: isWinner ? 10 : -5 },
        "ReputationService",
      );
    }

    return results;
  }

  /**
   * Get current on-chain reputation for a user
   */
  static async getOnChainReputation(userId: string): Promise<number | null> {
    // Get user's NFT token ID
    const [user] = await db
      .select({
        nftTokenId: users.nftTokenId,
        onChainRegistered: users.onChainRegistered,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.onChainRegistered || !user.nftTokenId) {
      return null;
    }

    // Query on-chain reputation
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(getCurrentRpcUrl()),
    });

    const reputation = (await publicClient.readContract({
      address: REPUTATION_SYSTEM,
      abi: parseAbi(REPUTATION_SYSTEM_ABI),
      functionName: "getReputation",
      args: [BigInt(user.nftTokenId)],
    })) as [bigint, bigint, bigint, bigint, bigint, bigint, boolean];

    // Reputation returns tuple: [totalBets, winningBets, totalVolume, profitLoss, accuracyScore, trustScore, isBanned]
    // We want trustScore (index 5) which is 0-10000 scale (divide by 100 to get 0-100)
    const trustScore = Number(reputation[5]);
    return Math.floor(trustScore / 100); // Convert from 0-10000 to 0-100
  }

  /**
   * Sync database reputation with on-chain reputation
   */
  static async syncUserReputation(userId: string): Promise<number | null> {
    const onChainReputation =
      await ReputationService.getOnChainReputation(userId);

    if (onChainReputation === null) {
      return null;
    }

    return onChainReputation;
  }

  /**
   * Batch update reputation for multiple market resolutions
   */
  static async batchUpdateReputation(
    resolutions: MarketResolution[],
  ): Promise<Record<string, ReputationUpdate[]>> {
    const allResults: Record<string, ReputationUpdate[]> = {};

    for (const resolution of resolutions) {
      const results =
        await ReputationService.updateReputationForResolvedMarket(resolution);
      allResults[resolution.marketId] = results;
    }

    return allResults;
  }
}
