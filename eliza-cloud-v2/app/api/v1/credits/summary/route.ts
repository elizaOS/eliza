/**
 * Credit Summary API
 *
 * GET /api/v1/credits/summary
 *
 * Returns complete credit status across all sources:
 * - Organization credits
 * - Agent budgets
 * - App credit balances
 * - Redeemable earnings
 *
 * This is the single source of truth for credit status.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { creditsService } from "@/lib/services/credits";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { appCreditsService } from "@/lib/services/app-credits";
import { dbRead } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import { userCharacters } from "@/db/schemas/user-characters";
import { eq } from "drizzle-orm";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { logger } from "@/lib/utils/logger";

/**
 * GET /api/v1/credits/summary
 * Get complete credit status for the authenticated user
 */
async function getSummaryHandler(request: NextRequest): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  // Use organization data from auth (already fetched, avoids redundant DB call)
  const org = user.organization;

  // Get all agents owned by this org
  const agents = await dbRead.query.userCharacters.findMany({
    where: eq(userCharacters.organization_id, user.organization_id),
  });

  // Get budgets for all agents
  const agentBudgets = await agentBudgetService.getOrgBudgets(
    user.organization_id,
  );
  const budgetMap = new Map(agentBudgets.map((b) => [b.agent_id, b]));

  // Get all apps owned by this org
  const orgApps = await dbRead.query.apps.findMany({
    where: eq(apps.organization_id, user.organization_id),
  });

  // Get redeemable earnings
  const earnings = await redeemableEarningsService.getBalance(user.id);

  // Get recent transactions
  const recentTransactions =
    await creditsService.listTransactionsByOrganization(
      user.organization_id,
      10,
    );

  // Build response
  const response = {
    success: true,

    // Organization credits (main spending pool)
    organization: {
      id: org.id,
      name: org.name,
      creditBalance: Number(org.credit_balance),

      // Auto top-up settings
      autoTopUpEnabled: org.auto_top_up_enabled,
      autoTopUpThreshold: org.auto_top_up_threshold
        ? Number(org.auto_top_up_threshold)
        : null,
      autoTopUpAmount: org.auto_top_up_amount
        ? Number(org.auto_top_up_amount)
        : null,
      hasPaymentMethod: !!org.stripe_default_payment_method,
    },

    // Agent budgets
    agents: agents.map((agent) => {
      const budget = budgetMap.get(agent.id);
      const allocated = budget ? Number(budget.allocated_budget) : 0;
      const spent = budget ? Number(budget.spent_budget) : 0;
      const available = allocated - spent;
      const dailyLimit = budget?.daily_limit
        ? Number(budget.daily_limit)
        : null;
      const dailySpent = budget ? Number(budget.daily_spent) : 0;

      return {
        id: agent.id,
        name: agent.name,
        isPublic: agent.is_public,
        monetizationEnabled: agent.monetization_enabled,

        // Budget status
        hasBudget: !!budget,
        allocated,
        spent,
        available,

        // Daily limits
        dailyLimit,
        dailySpent,
        dailyRemaining: dailyLimit ? dailyLimit - dailySpent : null,

        // Status
        isPaused: budget?.is_paused ?? false,
        pauseReason: budget?.pause_reason ?? null,

        // Earnings (from monetization)
        totalEarnings: Number(agent.total_creator_earnings),
        totalRequests: agent.total_inference_requests,
      };
    }),

    // Summary stats for agents
    agentsSummary: {
      total: agents.length,
      withBudget: agentBudgets.length,
      paused: agentBudgets.filter((b) => b.is_paused).length,
      totalAllocated: agentBudgets.reduce(
        (sum, b) => sum + Number(b.allocated_budget),
        0,
      ),
      totalSpent: agentBudgets.reduce(
        (sum, b) => sum + Number(b.spent_budget),
        0,
      ),
      totalAvailable: agentBudgets.reduce(
        (sum, b) => sum + (Number(b.allocated_budget) - Number(b.spent_budget)),
        0,
      ),
    },

    // Apps (miniapps)
    apps: orgApps.map((app) => ({
      id: app.id,
      name: app.name,
      slug: app.slug,
      monetizationEnabled: app.monetization_enabled,
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
      totalCreatorEarnings: Number(app.total_creator_earnings),
      totalPlatformRevenue: Number(app.total_platform_revenue),
    })),

    // Redeemable earnings (can be converted to elizaOS tokens)
    earnings: earnings
      ? {
          availableBalance: earnings.availableBalance,
          totalEarned: earnings.totalEarned,
          totalRedeemed: earnings.totalRedeemed,
          totalPending: earnings.totalPending,
          breakdown: earnings.breakdown,
        }
      : {
          availableBalance: 0,
          totalEarned: 0,
          totalRedeemed: 0,
          totalPending: 0,
          breakdown: { miniapps: 0, agents: 0, mcps: 0 },
        },

    // Recent transactions
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: Number(t.amount),
      description: t.description,
      createdAt: t.created_at.toISOString(),
    })),

    // Pricing info
    pricing: {
      creditsPerDollar: 100, // 100 credits = $1
      minimumTopUp: 5.0, // $5 minimum
      x402Enabled: process.env.ENABLE_X402_PAYMENTS === "true",
    },
  };

  logger.debug("[CreditsSummary] Fetched summary", {
    userId: user.id,
    orgId: user.organization_id,
    balance: response.organization.creditBalance,
    agentCount: response.agents.length,
  });

  return NextResponse.json(response);
}

// Export with rate limiting
export const GET = withRateLimit(getSummaryHandler, RateLimitPresets.STANDARD);

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}
