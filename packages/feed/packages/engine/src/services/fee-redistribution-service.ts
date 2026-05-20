/**
 * Fee Redistribution Service
 *
 * Manages the stability fund for maintaining NPC liquidity.
 * - Collects a portion of platform fees into a stability fund
 * - Redistributes to NPCs whose balance falls below threshold
 * - Keeps the economy liquid and prevents NPCs from going to $0
 *
 * @module engine/services/fee-redistribution-service
 */

import { actorState, Decimal, db, eq, gameConfigs } from "@feed/db";
import { logger } from "@feed/shared";
import { StaticDataRegistry } from "./static-data-registry";

/**
 * Configuration for the stability fund system
 */
export const STABILITY_FUND_CONFIG = {
  /**
   * Portion of platform fees diverted to stability fund (30%)
   * Platform gets 50% of total fees, we take 30% of that = 15% of total fees
   */
  PLATFORM_FEE_DIVERSION_RATE: 0.3,

  /**
   * Threshold for NPC top-up as ratio of tier minimum (20%)
   * NPCs below this get priority for redistribution
   */
  TOP_UP_THRESHOLD_RATIO: 0.2,

  /**
   * Target balance after top-up as ratio of tier minimum (50%)
   * We don't fill to 100% - NPCs need to earn the rest
   */
  TOP_UP_TARGET_RATIO: 0.5,

  /**
   * Maximum amount to redistribute per tick ($50,000)
   * Prevents draining the fund too quickly
   */
  MAX_REDISTRIBUTION_PER_TICK: 50000,

  /**
   * Maximum NPCs to top-up per tick (10)
   * Spreads the love over multiple ticks
   */
  MAX_NPCS_PER_TICK: 10,

  /**
   * Minimum fund balance before redistribution ($10,000)
   * Keep a reserve for emergencies
   */
  MIN_FUND_RESERVE: 10000,

  /**
   * GameConfig key for storing fund balance
   */
  FUND_BALANCE_KEY: "stability_fund_balance",
} as const;

/**
 * Tier minimum balances (must match GameBootstrapService)
 */
const TIER_MINIMUMS: Record<string, number> = {
  S_TIER: 50000,
  A_TIER: 25000,
  B_TIER: 10000,
  C_TIER: 5000,
};

const DEFAULT_TIER_MINIMUM = 5000;

/**
 * Result of a redistribution operation
 */
export interface RedistributionResult {
  npcsToppedUp: number;
  totalDistributed: number;
  fundBalanceBefore: number;
  fundBalanceAfter: number;
  details: Array<{
    npcId: string;
    npcName: string;
    balanceBefore: number;
    balanceAfter: number;
    amountReceived: number;
  }>;
}

/**
 * Fee Redistribution Service
 *
 * Maintains the stability fund and redistributes to struggling NPCs.
 */
export class FeeRedistributionService {
  /**
   * Get current stability fund balance
   */
  static async getFundBalance(): Promise<number> {
    const [config] = await db
      .select({ value: gameConfigs.value })
      .from(gameConfigs)
      .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY))
      .limit(1);

    if (!config) {
      return 0;
    }

    const balance = Number(config.value);
    return Number.isNaN(balance) ? 0 : balance;
  }

  /**
   * Add funds to the stability fund (called when fees are collected)
   *
   * @param amount - Amount to add to the fund
   */
  static async addToFund(amount: number): Promise<void> {
    if (amount <= 0) return;

    const currentBalance = await FeeRedistributionService.getFundBalance();
    const newBalance = currentBalance + amount;

    await db
      .insert(gameConfigs)
      .values({
        id: STABILITY_FUND_CONFIG.FUND_BALANCE_KEY,
        key: STABILITY_FUND_CONFIG.FUND_BALANCE_KEY,
        value: newBalance,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: gameConfigs.key,
        set: {
          value: newBalance,
          updatedAt: new Date(),
        },
      });

    logger.debug(
      "Added to stability fund",
      { amount, newBalance },
      "FeeRedistributionService",
    );
  }

  /**
   * Calculate the amount to divert from platform fees
   *
   * @param platformFeeAmount - The platform's share of the fee
   * @returns Amount to divert to stability fund
   */
  static calculateDiversionAmount(platformFeeAmount: number): number {
    return (
      platformFeeAmount * STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE
    );
  }

  /**
   * Get tier minimum for an NPC
   */
  private static getTierMinimum(tier: string | null | undefined): number {
    if (!tier) return DEFAULT_TIER_MINIMUM;
    return TIER_MINIMUMS[tier] ?? DEFAULT_TIER_MINIMUM;
  }

  /**
   * Find NPCs that need redistribution
   *
   * @returns Array of NPCs below threshold with their details
   */
  private static async findNPCsBelowThreshold(): Promise<
    Array<{
      id: string;
      name: string;
      tier: string | null;
      currentBalance: number;
      threshold: number;
      target: number;
      amountNeeded: number;
    }>
  > {
    // Get all actor states
    const allActorStates = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState);

    // Get static actor data for tier info
    const eligibleNPCs: Array<{
      id: string;
      name: string;
      tier: string | null;
      currentBalance: number;
      threshold: number;
      target: number;
      amountNeeded: number;
    }> = [];

    for (const state of allActorStates) {
      const actor = StaticDataRegistry.getActor(state.id);
      if (!actor) continue;

      const tierMinimum = FeeRedistributionService.getTierMinimum(actor.tier);
      const threshold =
        tierMinimum * STABILITY_FUND_CONFIG.TOP_UP_THRESHOLD_RATIO;
      const target = tierMinimum * STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO;
      const currentBalance = Number(state.tradingBalance);

      if (currentBalance < threshold) {
        const amountNeeded = Math.max(0, target - currentBalance);
        eligibleNPCs.push({
          id: state.id,
          name: actor.name,
          tier: actor.tier,
          currentBalance,
          threshold,
          target,
          amountNeeded,
        });
      }
    }

    // Sort by balance (lowest first - most in need get priority)
    eligibleNPCs.sort((a, b) => a.currentBalance - b.currentBalance);

    return eligibleNPCs;
  }

  /**
   * Redistribute funds to NPCs below threshold
   *
   * @returns Result of the redistribution
   */
  static async redistributeFunds(): Promise<RedistributionResult> {
    const fundBalanceBefore = await FeeRedistributionService.getFundBalance();

    // Check if we have enough in the fund
    const availableForDistribution =
      fundBalanceBefore - STABILITY_FUND_CONFIG.MIN_FUND_RESERVE;

    if (availableForDistribution <= 0) {
      logger.info(
        "Stability fund below reserve threshold, skipping redistribution",
        {
          fundBalance: fundBalanceBefore,
          reserve: STABILITY_FUND_CONFIG.MIN_FUND_RESERVE,
        },
        "FeeRedistributionService",
      );
      return {
        npcsToppedUp: 0,
        totalDistributed: 0,
        fundBalanceBefore,
        fundBalanceAfter: fundBalanceBefore,
        details: [],
      };
    }

    // Find NPCs that need help
    const eligibleNPCs =
      await FeeRedistributionService.findNPCsBelowThreshold();

    if (eligibleNPCs.length === 0) {
      logger.debug(
        "No NPCs below threshold, skipping redistribution",
        { fundBalance: fundBalanceBefore },
        "FeeRedistributionService",
      );
      return {
        npcsToppedUp: 0,
        totalDistributed: 0,
        fundBalanceBefore,
        fundBalanceAfter: fundBalanceBefore,
        details: [],
      };
    }

    // Calculate how much we can distribute
    const maxToDistribute = Math.min(
      availableForDistribution,
      STABILITY_FUND_CONFIG.MAX_REDISTRIBUTION_PER_TICK,
    );

    // Top up NPCs (limited by MAX_NPCS_PER_TICK)
    const npcsToProcess = eligibleNPCs.slice(
      0,
      STABILITY_FUND_CONFIG.MAX_NPCS_PER_TICK,
    );
    let totalDistributed = 0;
    const details: RedistributionResult["details"] = [];

    for (const npc of npcsToProcess) {
      // Check if we've hit our distribution limit
      if (totalDistributed >= maxToDistribute) break;

      // Calculate how much to give this NPC (capped by remaining budget)
      const amountToGive = Math.min(
        npc.amountNeeded,
        maxToDistribute - totalDistributed,
      );

      if (amountToGive <= 0) continue;

      // Update NPC balance
      const newBalance = npc.currentBalance + amountToGive;
      await db
        .update(actorState)
        .set({
          tradingBalance: new Decimal(newBalance).toString(),
          updatedAt: new Date(),
        })
        .where(eq(actorState.id, npc.id));

      totalDistributed += amountToGive;
      details.push({
        npcId: npc.id,
        npcName: npc.name,
        balanceBefore: npc.currentBalance,
        balanceAfter: newBalance,
        amountReceived: amountToGive,
      });

      logger.info(
        `Topped up NPC ${npc.name}`,
        {
          npcId: npc.id,
          balanceBefore: npc.currentBalance,
          balanceAfter: newBalance,
          amount: amountToGive,
        },
        "FeeRedistributionService",
      );
    }

    // Update fund balance
    const fundBalanceAfter = fundBalanceBefore - totalDistributed;
    await db
      .update(gameConfigs)
      .set({
        value: fundBalanceAfter,
        updatedAt: new Date(),
      })
      .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY));

    logger.info(
      "Redistribution completed",
      {
        npcsToppedUp: details.length,
        totalDistributed,
        fundBalanceBefore,
        fundBalanceAfter,
        eligibleNPCsRemaining: eligibleNPCs.length - details.length,
      },
      "FeeRedistributionService",
    );

    return {
      npcsToppedUp: details.length,
      totalDistributed,
      fundBalanceBefore,
      fundBalanceAfter,
      details,
    };
  }

  /**
   * Get statistics about the stability fund and NPC balances
   */
  static async getStats(): Promise<{
    fundBalance: number;
    npcsTotal: number;
    npcsBelowThreshold: number;
    totalDeficit: number;
    averageBalance: number;
  }> {
    const fundBalance = await FeeRedistributionService.getFundBalance();
    const eligibleNPCs =
      await FeeRedistributionService.findNPCsBelowThreshold();

    // Get all actor balances
    const allStates = await db
      .select({ tradingBalance: actorState.tradingBalance })
      .from(actorState);

    const totalBalance = allStates.reduce(
      (sum, s) => sum + Number(s.tradingBalance),
      0,
    );
    const averageBalance =
      allStates.length > 0 ? totalBalance / allStates.length : 0;
    const totalDeficit = eligibleNPCs.reduce(
      (sum, n) => sum + n.amountNeeded,
      0,
    );

    return {
      fundBalance,
      npcsTotal: allStates.length,
      npcsBelowThreshold: eligibleNPCs.length,
      totalDeficit,
      averageBalance,
    };
  }
}
