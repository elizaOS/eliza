/**
 * Agent Agent Billing Cron Job
 *
 * Hourly billing processor for Agent cloud agents (Docker-hosted).
 * - Charges organizations hourly for running agents ($0.01/hour)
 * - Charges for idle/stopped agents with snapshots ($0.0025/hour)
 * - Sends 48-hour shutdown warnings when credits are insufficient
 * - Shuts down agents that have been in warning state for 48+ hours
 *
 * Schedule: Runs every hour at minute 0 (0 * * * *)
 * Protected by CRON_SECRET.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead, dbWrite } from "@/db/client";
import { usersRepository } from "@/db/repositories";
import { type AgentBillingStatus, agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { organizationBilling } from "@/db/schemas/organization-billing";
import { organizations } from "@/db/schemas/organizations";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { emailService } from "@/lib/services/email";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const REBILL_GUARD_MINUTES = 55;

class AlreadyBilledRecentlyError extends Error {
  constructor() {
    super("Sandbox was already billed within the guard window");
    this.name = "AlreadyBilledRecentlyError";
  }
}

class InsufficientCreditsDuringBillingError extends Error {
  constructor() {
    super("Organization balance was insufficient when the debit was attempted");
    this.name = "InsufficientCreditsDuringBillingError";
  }
}

// ── Types ─────────────────────────────────────────────────────────────

interface BillingResult {
  sandboxId: string;
  agentName: string;
  organizationId: string;
  action: "billed" | "warning_sent" | "shutdown" | "skipped" | "error";
  amount?: number;
  newBalance?: number;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

async function getOrgUserEmail(organizationId: string): Promise<string | null> {
  try {
    const users = await usersRepository.listByOrganization(organizationId);
    return users.length > 0 && users[0].email ? users[0].email : null;
  } catch (error) {
    logger.error("[Agent Billing] Failed to get org user email", {
      organizationId,
      error,
    });
    return null;
  }
}

async function getOrgBalance(organizationId: string): Promise<number | null> {
  try {
    const [org] = await dbRead
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, organizationId));

    return org ? Number(org.credit_balance) : null;
  } catch (error) {
    logger.warn("[Agent Billing] Failed to refresh org balance", {
      organizationId,
      error,
    });
    return null;
  }
}

/**
 * Determine hourly rate for a sandbox based on its status.
 * Running → RUNNING_HOURLY_RATE, Stopped with backups → IDLE_HOURLY_RATE.
 */
function getHourlyRate(status: string): number {
  if (status === "running") return AGENT_PRICING.RUNNING_HOURLY_RATE;
  // Stopped agents are only billed if they have snapshots (checked in query).
  return AGENT_PRICING.IDLE_HOURLY_RATE;
}

// ── Per-Agent Billing ─────────────────────────────────────────────────

async function processSandboxBilling(
  sandbox: {
    id: string;
    agent_name: string | null;
    organization_id: string;
    user_id: string;
    status: string;
    billing_status: string;
    total_billed: string;
    shutdown_warning_sent_at: Date | null;
    scheduled_shutdown_at: Date | null;
  },
  org: {
    id: string;
    name: string;
    credit_balance: string;
    billing_email: string | null;
  },
  appUrl: string,
): Promise<BillingResult> {
  const sandboxId = sandbox.id;
  const agentName = sandbox.agent_name ?? sandboxId.slice(0, 8);
  const organizationId = sandbox.organization_id;
  const hourlyCost = getHourlyRate(sandbox.status);
  const currentBalance = Number(org.credit_balance);
  const now = new Date();

  async function queueShutdownWarning(): Promise<BillingResult> {
    if (sandbox.billing_status === "shutdown_pending" || sandbox.shutdown_warning_sent_at) {
      return {
        sandboxId,
        agentName,
        organizationId,
        action: "skipped",
        error: "Waiting for scheduled shutdown",
      };
    }

    const liveBalance = (await getOrgBalance(organizationId)) ?? currentBalance;
    if (liveBalance >= hourlyCost) {
      logger.info(
        `[Agent Billing] Skipping shutdown warning for ${agentName}; balance recovered before warning`,
        {
          sandboxId,
          hourlyCost,
          liveBalance,
        },
      );
      return {
        sandboxId,
        agentName,
        organizationId,
        action: "skipped",
        error: "Balance recovered before warning could be sent",
      };
    }

    const shutdownTime = new Date(
      now.getTime() + AGENT_PRICING.GRACE_PERIOD_HOURS * 60 * 60 * 1000,
    );

    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "shutdown_pending" as AgentBillingStatus,
        shutdown_warning_sent_at: now,
        scheduled_shutdown_at: shutdownTime,
        updated_at: now,
      })
      .where(eq(agentSandboxes.id, sandboxId));

    const recipientEmail = org.billing_email || (await getOrgUserEmail(organizationId));
    if (recipientEmail) {
      // Reuse the container shutdown warning email template — content is generic enough
      await emailService.sendContainerShutdownWarningEmail({
        email: recipientEmail,
        organizationName: org.name,
        containerName: `Agent Agent: ${agentName}`,
        projectName: "Eliza Cloud",
        dailyCost: hourlyCost * 24,
        monthlyCost: hourlyCost * 24 * 30,
        currentBalance: liveBalance,
        requiredCredits: hourlyCost,
        minimumRecommended: hourlyCost * 24 * 7, // 1 week
        shutdownTime: shutdownTime.toLocaleString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }),
        billingUrl: `${appUrl}/dashboard/billing`,
        dashboardUrl: `${appUrl}/dashboard/agents`,
      });

      logger.info(`[Agent Billing] Sent shutdown warning for ${agentName} to ${recipientEmail}`);
    }

    return {
      sandboxId,
      agentName,
      organizationId,
      action: "warning_sent",
      amount: hourlyCost,
    };
  }

  logger.info(`[Agent Billing] Processing ${agentName}`, {
    sandboxId,
    hourlyCost,
    currentBalance,
    status: sandbox.status,
    billingStatus: sandbox.billing_status,
  });

  // ── Scheduled shutdown check ────────────────────────────────────
  if (
    sandbox.billing_status === "shutdown_pending" &&
    sandbox.scheduled_shutdown_at &&
    new Date(sandbox.scheduled_shutdown_at) <= now
  ) {
    logger.info(`[Agent Billing] Shutting down agent ${agentName} due to insufficient credits`);

    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        billing_status: "suspended" as AgentBillingStatus,
        sandbox_id: null,
        bridge_url: null,
        health_url: null,
        updated_at: now,
      })
      .where(eq(agentSandboxes.id, sandboxId));

    return { sandboxId, agentName, organizationId, action: "shutdown" };
  }

  // ── Sufficient credits — bill the hour ──────────────────────────
  const billingDescription =
    sandbox.status === "running"
      ? `Eliza agent hosting (running): ${agentName}`
      : `Eliza agent storage (idle): ${agentName}`;
  let billingResult: { newBalance: number; transactionId: string };
  try {
    billingResult = await dbWrite.transaction(async (tx) => {
      const rebillCutoff = new Date(now.getTime() - REBILL_GUARD_MINUTES * 60_000);
      // Claim the sandbox row up front so overlapping cron runs serialize on the same record.
      const [claimedSandbox] = await tx
        .update(agentSandboxes)
        .set({ updated_at: now })
        .where(
          and(
            eq(agentSandboxes.id, sandboxId),
            or(
              isNull(agentSandboxes.last_billed_at),
              lt(agentSandboxes.last_billed_at, rebillCutoff),
            ),
          ),
        )
        .returning({ id: agentSandboxes.id });

      if (!claimedSandbox) {
        throw new AlreadyBilledRecentlyError();
      }

      // Atomic credit deduction — the balance floor lives in SQL, not the stale org snapshot.
      const [updatedOrg] = await tx
        .update(organizations)
        .set({
          credit_balance: sql`${organizations.credit_balance} - ${String(hourlyCost)}`,
          updated_at: now,
        })
        .where(
          and(
            eq(organizations.id, organizationId),
            gte(organizations.credit_balance, String(hourlyCost)),
          ),
        )
        .returning({ credit_balance: organizations.credit_balance });

      if (!updatedOrg) {
        throw new InsufficientCreditsDuringBillingError();
      }

      const newBalance = Number(updatedOrg.credit_balance);

      // Create credit transaction
      const [creditTx] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: organizationId,
          user_id: sandbox.user_id,
          amount: String(-hourlyCost),
          type: "debit",
          description: billingDescription,
          metadata: {
            sandbox_id: sandboxId,
            agent_name: agentName,
            billing_type: sandbox.status === "running" ? "agent_running" : "agent_idle",
            hourly_rate: hourlyCost,
            billing_hour: now.toISOString(),
          },
          created_at: now,
        })
        .returning();

      const nextBillingStatus: AgentBillingStatus =
        newBalance < AGENT_PRICING.LOW_CREDIT_WARNING ? "warning" : "active";

      // Update sandbox billing fields — use SQL increment for total_billed to avoid races
      await tx
        .update(agentSandboxes)
        .set({
          last_billed_at: now,
          billing_status: nextBillingStatus,
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          hourly_rate: String(hourlyCost),
          total_billed: sql`${agentSandboxes.total_billed} + ${String(hourlyCost)}`,
          updated_at: now,
        })
        .where(eq(agentSandboxes.id, sandboxId));

      return { newBalance, transactionId: creditTx.id };
    });
  } catch (error) {
    if (error instanceof AlreadyBilledRecentlyError) {
      logger.info(
        `[Agent Billing] Skipping ${agentName}; already billed within ${REBILL_GUARD_MINUTES} minutes`,
        {
          sandboxId,
        },
      );
      return {
        sandboxId,
        agentName,
        organizationId,
        action: "skipped",
        error: "Already billed recently",
      };
    }

    if (error instanceof InsufficientCreditsDuringBillingError) {
      return queueShutdownWarning();
    }

    throw error;
  }

  logger.info(`[Agent Billing] Billed ${agentName}: $${hourlyCost.toFixed(4)}`, {
    sandboxId,
    newBalance: billingResult.newBalance,
    transactionId: billingResult.transactionId,
  });

  return {
    sandboxId,
    agentName,
    organizationId,
    action: "billed",
    amount: hourlyCost,
    newBalance: billingResult.newBalance,
  };
}

// ── Main Handler ──────────────────────────────────────────────────────

async function handleAgentBilling(c: AppContext): Promise<Response> {
  const startTime = Date.now();
  const now = new Date();
  const rebillCutoff = new Date(now.getTime() - REBILL_GUARD_MINUTES * 60_000);
  try {
    requireCronSecret(c);
    const appUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

    logger.info("[Agent Billing] Starting hourly billing run");
    // ── 1. Running agents (always billed) ───────────────────────────
    const runningSandboxes = await dbRead
      .select({
        id: agentSandboxes.id,
        agent_name: agentSandboxes.agent_name,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        status: agentSandboxes.status,
        billing_status: agentSandboxes.billing_status,
        last_billed_at: agentSandboxes.last_billed_at,
        total_billed: agentSandboxes.total_billed,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          inArray(agentSandboxes.billing_status, [
            "active",
            "warning",
            "shutdown_pending",
          ] satisfies AgentBillingStatus[]),
          or(
            and(
              eq(agentSandboxes.billing_status, "shutdown_pending"),
              isNotNull(agentSandboxes.scheduled_shutdown_at),
              lte(agentSandboxes.scheduled_shutdown_at, now),
            ),
            isNull(agentSandboxes.last_billed_at),
            lt(agentSandboxes.last_billed_at, rebillCutoff),
          ),
        ),
      );

    // ── 2. Stopped agents with at least one backup (idle storage) ───
    // Sub-select sandbox IDs that have backups
    const stoppedWithBackups = await dbRead
      .select({
        id: agentSandboxes.id,
        agent_name: agentSandboxes.agent_name,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        status: agentSandboxes.status,
        billing_status: agentSandboxes.billing_status,
        last_billed_at: agentSandboxes.last_billed_at,
        total_billed: agentSandboxes.total_billed,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "stopped"),
          inArray(agentSandboxes.billing_status, [
            "active",
            "warning",
            "shutdown_pending",
          ] satisfies AgentBillingStatus[]),
          // Only bill stopped agents that have snapshot data
          isNotNull(agentSandboxes.last_backup_at),
          or(
            and(
              eq(agentSandboxes.billing_status, "shutdown_pending"),
              isNotNull(agentSandboxes.scheduled_shutdown_at),
              lte(agentSandboxes.scheduled_shutdown_at, now),
            ),
            isNull(agentSandboxes.last_billed_at),
            lt(agentSandboxes.last_billed_at, rebillCutoff),
          ),
        ),
      );

    const allBillable = [...runningSandboxes, ...stoppedWithBackups];

    if (allBillable.length === 0) {
      logger.info("[Agent Billing] No billable sandboxes");
      return c.json({
        success: true,
        data: {
          sandboxesProcessed: 0,
          sandboxesBilled: 0,
          warningsSent: 0,
          sandboxesShutdown: 0,
          totalRevenue: 0,
          errors: 0,
          duration: Date.now() - startTime,
        },
      });
    }

    logger.info(
      `[Agent Billing] Processing ${allBillable.length} sandboxes (${runningSandboxes.length} running, ${stoppedWithBackups.length} idle)`,
    );

    // ── Fetch organizations ─────────────────────────────────────────
    const orgIds = [...new Set(allBillable.map((s) => s.organization_id))];

    const orgs = await dbRead
      .select({
        id: organizations.id,
        name: organizations.name,
        credit_balance: organizations.credit_balance,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    const billingData = await dbRead
      .select({
        organization_id: organizationBilling.organization_id,
        billing_email: organizationBilling.billing_email,
      })
      .from(organizationBilling)
      .where(inArray(organizationBilling.organization_id, orgIds));

    const billingEmailMap = new Map(billingData.map((b) => [b.organization_id, b.billing_email]));
    const orgMap = new Map(
      orgs.map((o) => [o.id, { ...o, billing_email: billingEmailMap.get(o.id) ?? null }]),
    );

    // ── Process each sandbox ────────────────────────────────────────
    const results: BillingResult[] = [];
    let totalRevenue = 0;
    let sandboxesBilled = 0;
    let warningsSent = 0;
    let sandboxesShutdown = 0;
    let errors = 0;

    for (const sandbox of allBillable) {
      const org = orgMap.get(sandbox.organization_id);
      if (!org) {
        results.push({
          sandboxId: sandbox.id,
          agentName: sandbox.agent_name ?? "unknown",
          organizationId: sandbox.organization_id,
          action: "error",
          error: "Organization not found",
        });
        errors++;
        continue;
      }

      try {
        const result = await processSandboxBilling(sandbox, org, appUrl);
        results.push(result);

        if (result.action === "billed" && result.amount) {
          totalRevenue += result.amount;
          sandboxesBilled++;
          // Update org balance in memory for next sandbox in same org
          org.credit_balance = String(result.newBalance);
        } else if (result.action === "warning_sent") {
          warningsSent++;
          // Refresh in-memory balance after warning (balance may have changed)
          const freshBalance = await getOrgBalance(org.id);
          if (freshBalance !== null) org.credit_balance = String(freshBalance);
        } else if (result.action === "shutdown") {
          sandboxesShutdown++;
          // Refresh in-memory balance after shutdown action
          const freshBalance = await getOrgBalance(org.id);
          if (freshBalance !== null) org.credit_balance = String(freshBalance);
        } else if (result.action === "error") {
          errors++;
        }
      } catch (error) {
        logger.error(
          `[Agent Billing] Error processing sandbox ${sandbox.agent_name ?? sandbox.id}`,
          { error },
        );
        results.push({
          sandboxId: sandbox.id,
          agentName: sandbox.agent_name ?? "unknown",
          organizationId: sandbox.organization_id,
          action: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        errors++;
      }
    }

    const duration = Date.now() - startTime;

    logger.info("[Agent Billing] Completed hourly billing run", {
      sandboxesProcessed: results.length,
      sandboxesBilled,
      warningsSent,
      sandboxesShutdown,
      totalRevenue: totalRevenue.toFixed(4),
      errors,
      duration,
    });

    return c.json({
      success: true,
      data: {
        sandboxesProcessed: results.length,
        sandboxesBilled,
        warningsSent,
        sandboxesShutdown,
        totalRevenue: Math.round(totalRevenue * 10000) / 10000,
        errors,
        duration,
        timestamp: now.toISOString(),
        resultsTruncated: results.length > 100,
        results: results.slice(0, 100),
      },
    });
  } catch (error) {
    logger.error("[Agent Billing] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

const app = new Hono<AppEnv>();
app.get("/", (c) => handleAgentBilling(c));
app.post("/", (c) => handleAgentBilling(c));
export default app;
