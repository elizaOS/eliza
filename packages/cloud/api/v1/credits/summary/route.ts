/**
 * GET /api/v1/credits/summary
 * Single source of truth for credit status (org credits, agent budgets,
 * app balances, redeemable earnings).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  ORGANIZATION_CREDIT_CHECKOUT_LIMITS,
  ORGANIZATION_CREDIT_PRICING,
} from "@elizaos/cloud-shared/billing";
import { dbRead } from "@elizaos/cloud-shared/db/client";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { userCharacters } from "@elizaos/cloud-shared/db/schemas/user-characters";
import {
  failureResponse,
  NotFoundError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { agentBudgetService } from "@elizaos/cloud-shared/lib/services/agent-budgets";
import { creditsService } from "@elizaos/cloud-shared/lib/services/credits";
import { organizationsService } from "@elizaos/cloud-shared/lib/services/organizations";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

const SUMMARY_RECENT_LIMIT = 5;

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    // All eight reads are independent after auth — run them in parallel to
    // collapse the sequential DB round-trips into a single wall-clock wait.
    const [
      org,
      agentCountRows,
      recentAgents,
      agentBudgets,
      appCountRows,
      recentApps,
      earnings,
      recentTransactions,
    ] = await Promise.all([
      organizationsService.getById(user.organization_id),
      dbRead
        .select({ value: count() })
        .from(userCharacters)
        .where(eq(userCharacters.organization_id, user.organization_id)),
      dbRead.query.userCharacters.findMany({
        where: eq(userCharacters.organization_id, user.organization_id),
        orderBy: desc(userCharacters.updated_at),
        limit: SUMMARY_RECENT_LIMIT,
      }),
      agentBudgetService.getOrgBudgets(user.organization_id),
      dbRead
        .select({ value: count() })
        .from(apps)
        .where(eq(apps.organization_id, user.organization_id)),
      dbRead.query.apps.findMany({
        where: eq(apps.organization_id, user.organization_id),
        orderBy: desc(apps.updated_at),
        limit: SUMMARY_RECENT_LIMIT,
      }),
      redeemableEarningsService.getBalance(user.id),
      creditsService.listTransactionsByOrganization(user.organization_id, 10),
    ]);

    if (!org) throw NotFoundError("Organization not found");

    const agentTotal = agentCountRows[0]?.value ?? 0;
    const appTotal = appCountRows[0]?.value ?? 0;
    const budgetMap = new Map(agentBudgets.map((b) => [b.agent_id, b]));

    const response = {
      success: true,
      organization: {
        id: org.id,
        name: org.name,
        creditBalance: Number(org.credit_balance),
        autoTopUpEnabled: org.auto_top_up_enabled,
        autoTopUpThreshold: org.auto_top_up_threshold
          ? Number(org.auto_top_up_threshold)
          : null,
        autoTopUpAmount: org.auto_top_up_amount
          ? Number(org.auto_top_up_amount)
          : null,
        hasPaymentMethod: !!org.stripe_default_payment_method,
      },
      agents: recentAgents.map((agent) => {
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
          hasBudget: !!budget,
          allocated,
          spent,
          available,
          dailyLimit,
          dailySpent,
          dailyRemaining: dailyLimit ? dailyLimit - dailySpent : null,
          isPaused: budget?.is_paused ?? false,
          pauseReason: budget?.pause_reason ?? null,
          totalEarnings: Number(agent.total_creator_earnings),
          totalRequests: agent.total_inference_requests,
        };
      }),
      agentsSummary: {
        total: agentTotal,
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
          (sum, b) =>
            sum + (Number(b.allocated_budget) - Number(b.spent_budget)),
          0,
        ),
      },
      apps: recentApps.map((appRow) => ({
        id: appRow.id,
        name: appRow.name,
        slug: appRow.slug,
        monetizationEnabled: appRow.monetization_enabled,
        inferenceMarkupPercentage: Number(appRow.inference_markup_percentage),
        totalCreatorEarnings: Number(appRow.total_creator_earnings),
        totalPlatformRevenue: Number(appRow.total_platform_revenue),
      })),
      appsSummary: {
        total: appTotal,
      },
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
      recentTransactions: recentTransactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        description: t.description,
        createdAt: t.created_at.toISOString(),
      })),
      pricing: {
        ...ORGANIZATION_CREDIT_PRICING,
        // Advertised bounds mirror the enforced checkout contract (#22963):
        // the summary must never restate an independent minimum.
        minimumTopUp: ORGANIZATION_CREDIT_CHECKOUT_LIMITS.minAmountUsd,
        maximumTopUp: ORGANIZATION_CREDIT_CHECKOUT_LIMITS.maxAmountUsd,
        x402Enabled: true,
      },
    };

    logger.debug("[CreditsSummary] Fetched summary", {
      userId: user.id,
      orgId: user.organization_id,
      balance: response.organization.creditBalance,
      agentCount: agentTotal,
      appCount: appTotal,
    });

    return c.json(response);
  } catch (error) {
    logger.error("[CreditsSummary] Error", { error });
    return failureResponse(c, error);
  }
});

export default app;
