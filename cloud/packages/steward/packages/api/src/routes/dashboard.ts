/**
 * Aggregated dashboard endpoint — single API call for widget rendering.
 *
 * Mount: app.route("/dashboard", dashboardRoutes)
 */

import type { AgentDashboardResponse } from "@stwd/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  approvalQueue,
  db,
  ensureAgentForTenant,
  getPolicySet,
  getTransactionStats,
  requireAgentAccess,
  toTxRecord,
  transactions,
  vault,
} from "../services/context";

export const dashboardRoutes = new Hono<{ Variables: AppVariables }>();

// ─── GET /dashboard/:agentId — aggregated agent dashboard ─────────────────────

dashboardRoutes.get("/:agentId", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
  }

  // Get agent identity
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  // Run queries in parallel
  const [policyRules, txStats, recentTxRows, pendingApprovalsResult, balanceResult] =
    await Promise.all([
      // Policies
      getPolicySet(tenantId, agentId),

      // Spend stats
      getTransactionStats(agentId),

      // Recent transactions (last 5)
      db
        .select()
        .from(transactions)
        .where(eq(transactions.agentId, agentId))
        .orderBy(desc(transactions.createdAt))
        .limit(5),

      // Pending approvals count
      db
        .select({ count: sql<number>`count(*)` })
        .from(approvalQueue)
        .where(and(eq(approvalQueue.agentId, agentId), eq(approvalQueue.status, "pending"))),

      // Balance — try to get from vault
      vault.getBalance(tenantId, agentId).catch(() => null),
    ]);

  // Get monthly spend
  const oneMonthAgo = new Date(Date.now() - 30 * 86400_000);
  const [monthlyStats] = await db
    .select({
      spentThisMonth: sql<string>`coalesce(sum((${transactions.value})::numeric), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        gte(transactions.createdAt, oneMonthAgo),
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
      ),
    );

  const spentToday = txStats.spentToday.toString();
  const spentThisWeek = txStats.spentThisWeek.toString();
  const spentThisMonth = monthlyStats?.spentThisMonth ?? "0";

  const formatWei = (wei: string): string => {
    const n = Number(BigInt(wei)) / 1e18;
    return n.toFixed(6);
  };

  const dashboard: AgentDashboardResponse = {
    agent,
    balances: {
      evm: balanceResult
        ? {
            native: balanceResult.native.toString(),
            nativeFormatted: balanceResult.nativeFormatted,
            chainId: balanceResult.chainId,
            symbol: balanceResult.symbol,
          }
        : undefined,
    },
    spend: {
      today: spentToday,
      thisWeek: spentThisWeek,
      thisMonth: spentThisMonth,
      todayFormatted: formatWei(spentToday),
      thisWeekFormatted: formatWei(spentThisWeek),
      thisMonthFormatted: formatWei(spentThisMonth),
    },
    policies: policyRules,
    pendingApprovals: Number(pendingApprovalsResult[0]?.count ?? 0),
    recentTransactions: recentTxRows.map(toTxRecord),
  };

  return c.json<ApiResponse<AgentDashboardResponse>>({
    ok: true,
    data: dashboard,
  });
});
