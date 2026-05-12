/**
 * Agent Monetization Service
 *
 * Handles monetization for public agents, matching the miniapp monetization flow.
 *
 * When monetization is enabled on an agent:
 * 1. Users pay base cost + creator markup
 * 2. Base cost goes to platform
 * 3. Creator markup goes to agent owner's REDEEMABLE EARNINGS
 * 4. Earnings can be redeemed for elizaOS tokens
 *
 * Supports:
 * - HTTP chat endpoints
 * - A2A protocol
 * - MCP protocol
 * - ERC-8004 registered agents
 */

import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { userCharacters } from "@/db/schemas/user-characters";
import { calculateCost, estimateRequestCost, getProviderFromModel } from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import { creditsService } from "./credits";
import { redeemableEarningsService } from "./redeemable-earnings";

// ============================================================================
// TYPES
// ============================================================================

interface AgentMonetizationInfo {
  agentId: string;
  agentName: string;
  ownerId: string; // user_id of the agent owner
  organizationId: string;
  monetizationEnabled: boolean;
  markupPercentage: number;
  totalEarnings: number;
  totalRequests: number;
}

interface ChargeResult {
  success: boolean;
  baseCost: number;
  creatorMarkup: number;
  totalCost: number;
  error?: string;
}

interface RecordEarningsParams {
  agentId: string;
  agentName: string;
  ownerId: string;
  earnings: number;
  consumerOrgId?: string;
  model?: string;
  tokens?: number;
  protocol: "http" | "a2a" | "mcp";
}

interface AgentUsageParams {
  agentId: string;
  agentName: string;
  ownerId: string;
  monetizationEnabled: boolean;
  markupPercentage: number;
  model: string;
  messages: Array<{ role: string; content: string }>;
  consumerOrgId: string;
  protocol: "http" | "a2a" | "mcp";
}

// ============================================================================
// SERVICE
// ============================================================================

class AgentMonetizationService {
  /**
   * Get agent monetization info
   */
  async getAgentMonetization(agentId: string): Promise<AgentMonetizationInfo | null> {
    const agent = await dbRead.query.userCharacters.findFirst({
      where: eq(userCharacters.id, agentId),
    });

    if (!agent) return null;

    return {
      agentId: agent.id,
      agentName: agent.name,
      ownerId: agent.user_id,
      organizationId: agent.organization_id,
      monetizationEnabled: agent.monetization_enabled,
      markupPercentage: Number(agent.inference_markup_percentage || 0),
      totalEarnings: Number(agent.total_creator_earnings),
      totalRequests: agent.total_inference_requests,
    };
  }

  /**
   * Estimate cost for agent usage
   */
  async estimateCost(
    model: string,
    messages: Array<{ role: string; content: string }>,
    markupPercentage: number,
    monetizationEnabled: boolean,
  ): Promise<{ baseCost: number; creatorMarkup: number; totalCost: number }> {
    const baseCost = await estimateRequestCost(model, messages);
    const creatorMarkup = monetizationEnabled ? baseCost * (markupPercentage / 100) : 0;
    const totalCost = baseCost + creatorMarkup;

    return { baseCost, creatorMarkup, totalCost };
  }

  /**
   * Pre-charge consumer for agent usage
   *
   * This is called BEFORE the inference to ensure the user has sufficient credits.
   */
  async preChargeConsumer(
    consumerOrgId: string,
    agentName: string,
    estimatedCost: number,
    metadata: Record<string, unknown>,
  ): Promise<ChargeResult> {
    const result = await creditsService.deductCredits({
      organizationId: consumerOrgId,
      amount: estimatedCost,
      description: `Agent: ${agentName}`,
      metadata,
    });

    if (!result.success) {
      return {
        success: false,
        baseCost: 0,
        creatorMarkup: 0,
        totalCost: estimatedCost,
        error: `Insufficient credits. Required: $${estimatedCost.toFixed(4)}`,
      };
    }

    return {
      success: true,
      baseCost: estimatedCost,
      creatorMarkup: 0,
      totalCost: estimatedCost,
    };
  }

  /**
   * Record agent creator earnings
   *
   * CRITICAL: This adds earnings to the user's REDEEMABLE EARNINGS,
   * NOT to org credits. These can be redeemed for elizaOS tokens.
   */
  async recordCreatorEarnings(
    params: RecordEarningsParams,
  ): Promise<{ success: boolean; error?: string }> {
    const { agentId, agentName, ownerId, earnings, consumerOrgId, model, tokens, protocol } =
      params;

    if (earnings <= 0) {
      return { success: true }; // No earnings to record
    }

    // Use Decimal for precision
    const earningsDecimal = new Decimal(earnings).toFixed(4);

    // 1. Add to redeemable earnings (for elizaOS token redemption)
    const result = await redeemableEarningsService.addEarnings({
      userId: ownerId,
      amount: earnings,
      source: "agent",
      sourceId: agentId,
      description: `Agent earnings: ${agentName} via ${protocol}`,
      metadata: {
        agent_id: agentId,
        agent_name: agentName,
        consumer_org_id: consumerOrgId,
        model,
        tokens,
        protocol,
      },
    });

    if (!result.success) {
      logger.error("[AgentMonetization] Failed to record redeemable earnings", {
        agentId,
        ownerId,
        earnings,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    // 2. Update agent's earnings tracking
    await dbWrite
      .update(userCharacters)
      .set({
        total_creator_earnings: sql`${userCharacters.total_creator_earnings} + ${earningsDecimal}`,
        total_inference_requests: sql`${userCharacters.total_inference_requests} + 1`,
        updated_at: new Date(),
      })
      .where(eq(userCharacters.id, agentId));

    logger.info("[AgentMonetization] Creator earnings recorded", {
      agentId,
      agentName: agentName.slice(0, 20),
      ownerId: ownerId.slice(0, 8) + "...",
      earnings: Number(earningsDecimal),
      protocol,
      ledgerEntryId: result.ledgerEntryId,
    });

    return { success: true };
  }

  /**
   * Process complete agent usage with monetization
   *
   * This is the main entry point for charging and recording agent usage.
   * Call this after successful inference.
   */
  async processUsage(
    params: AgentUsageParams,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<{
    success: boolean;
    actualBaseCost: number;
    actualCreatorMarkup: number;
    actualTotal: number;
    error?: string;
  }> {
    const {
      agentId,
      agentName,
      ownerId,
      monetizationEnabled,
      markupPercentage,
      model,
      consumerOrgId,
      protocol,
    } = params;

    // Calculate actual cost based on token usage
    const provider = getProviderFromModel(model);
    const { totalCost: actualBaseCost } = await calculateCost(
      model,
      provider,
      usage.inputTokens,
      usage.outputTokens,
    );

    const actualCreatorMarkup = monetizationEnabled ? actualBaseCost * (markupPercentage / 100) : 0;
    const actualTotal = actualBaseCost + actualCreatorMarkup;

    // Record creator earnings if monetization is enabled
    if (monetizationEnabled && actualCreatorMarkup > 0) {
      const earningsResult = await this.recordCreatorEarnings({
        agentId,
        agentName,
        ownerId,
        earnings: actualCreatorMarkup,
        consumerOrgId,
        model,
        tokens: usage.inputTokens + usage.outputTokens,
        protocol,
      });

      if (!earningsResult.success) {
        logger.warn("[AgentMonetization] Earnings recording failed", {
          agentId,
          error: earningsResult.error,
        });
        // Don't fail the request, just log the warning
      }
    }

    return {
      success: true,
      actualBaseCost,
      actualCreatorMarkup,
      actualTotal,
    };
  }

  /**
   * Handle cost difference between estimate and actual
   *
   * Called after inference to refund or charge the difference.
   */
  async handleCostDifference(
    consumerOrgId: string,
    agentName: string,
    estimatedCost: number,
    actualCost: number,
  ): Promise<void> {
    const diff = actualCost - estimatedCost;

    if (diff < 0) {
      // Refund the overcharge
      await creditsService.refundCredits({
        organizationId: consumerOrgId,
        amount: -diff,
        description: `Agent refund: ${agentName}`,
      });
    } else if (diff > 0) {
      // Charge additional (typically small amount)
      await creditsService.deductCredits({
        organizationId: consumerOrgId,
        amount: diff,
        description: `Agent additional: ${agentName}`,
      });
    }
  }

  /**
   * Update agent monetization settings
   */
  async updateSettings(
    agentId: string,
    ownerId: string,
    settings: {
      monetizationEnabled?: boolean;
      markupPercentage?: number;
      payoutWalletAddress?: string;
    },
  ): Promise<{ success: boolean; error?: string }> {
    // Verify ownership
    const agent = await dbRead.query.userCharacters.findFirst({
      where: eq(userCharacters.id, agentId),
    });

    if (!agent) {
      return { success: false, error: "Agent not found" };
    }

    if (agent.user_id !== ownerId) {
      return { success: false, error: "Not authorized to update this agent" };
    }

    if (!agent.is_public) {
      return {
        success: false,
        error: "Agent must be public to enable monetization",
      };
    }

    // Validate markup percentage
    if (settings.markupPercentage !== undefined) {
      if (settings.markupPercentage < 0 || settings.markupPercentage > 1000) {
        return { success: false, error: "Markup must be between 0% and 1000%" };
      }
    }

    // Update settings
    await dbWrite
      .update(userCharacters)
      .set({
        ...(settings.monetizationEnabled !== undefined && {
          monetization_enabled: settings.monetizationEnabled,
        }),
        ...(settings.markupPercentage !== undefined && {
          inference_markup_percentage: String(settings.markupPercentage),
        }),
        ...(settings.payoutWalletAddress !== undefined && {
          payout_wallet_address: settings.payoutWalletAddress,
        }),
        updated_at: new Date(),
      })
      .where(eq(userCharacters.id, agentId));

    logger.info("[AgentMonetization] Settings updated", {
      agentId,
      ownerId: ownerId.slice(0, 8) + "...",
      settings,
    });

    return { success: true };
  }

  /**
   * Get earnings summary for an agent owner
   */
  async getEarningsSummary(userId: string): Promise<{
    totalAgentEarnings: number;
    agentCount: number;
    topAgents: Array<{
      id: string;
      name: string;
      earnings: number;
      requests: number;
    }>;
  }> {
    // Get all agents owned by this user
    const agents = await dbRead.query.userCharacters.findMany({
      where: eq(userCharacters.user_id, userId),
    });

    const monetizedAgents = agents.filter((a) => a.monetization_enabled);

    const totalEarnings = monetizedAgents.reduce(
      (sum, a) => sum + Number(a.total_creator_earnings),
      0,
    );

    const topAgents = monetizedAgents
      .sort((a, b) => Number(b.total_creator_earnings) - Number(a.total_creator_earnings))
      .slice(0, 5)
      .map((a) => ({
        id: a.id,
        name: a.name,
        earnings: Number(a.total_creator_earnings),
        requests: a.total_inference_requests,
      }));

    return {
      totalAgentEarnings: totalEarnings,
      agentCount: monetizedAgents.length,
      topAgents,
    };
  }
}

// Export singleton
export const agentMonetizationService = new AgentMonetizationService();
