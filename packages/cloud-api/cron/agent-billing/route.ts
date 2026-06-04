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

import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { usersRepository } from "@/db/repositories";
import {
  type AgentBillingOrganization,
  type AgentBillingSandbox,
  agentBillingRepository,
} from "@/db/repositories/agent-billing";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { emailService } from "@/lib/services/email";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const REBILL_GUARD_MINUTES = 55;

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
    return await agentBillingRepository.getOrganizationCreditBalance(
      organizationId,
    );
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
  sandbox: AgentBillingSandbox,
  org: AgentBillingOrganization,
  appUrl: string,
): Promise<BillingResult> {
  const sandboxId = sandbox.id;
  const agentName = sandbox.agent_name ?? sandboxId.slice(0, 8);
  const organizationId = sandbox.organization_id;
  const hourlyCost = getHourlyRate(sandbox.status);
  const currentBalance = Number(org.credit_balance);
  const now = new Date();

  async function queueShutdownWarning(): Promise<BillingResult> {
    if (
      sandbox.billing_status === "shutdown_pending" ||
      sandbox.shutdown_warning_sent_at
    ) {
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

    await agentBillingRepository.scheduleShutdownWarning(
      sandboxId,
      now,
      shutdownTime,
    );

    const recipientEmail =
      org.billing_email || (await getOrgUserEmail(organizationId));
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

      logger.info(
        `[Agent Billing] Sent shutdown warning for ${agentName} to ${recipientEmail}`,
      );
    }

    await notifyWaifuCreditWebhook(sandbox, "credits.low", {
      eventId: `agent-billing:${sandboxId}:credits.low:${now.toISOString()}`,
      creditsRemaining: liveBalance,
      requiredCredits: hourlyCost,
      scheduledShutdownAt: shutdownTime.toISOString(),
    });

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
    logger.info(
      `[Agent Billing] Shutting down agent ${agentName} due to insufficient credits`,
    );

    const shutdown = await elizaSandboxService.shutdown(
      sandboxId,
      organizationId,
    );
    if (!shutdown.success) {
      throw new Error(
        `Container shutdown failed before credit suspension: ${
          shutdown.error ?? "unknown error"
        }`,
      );
    }

    await agentBillingRepository.suspendSandboxForInsufficientCredits(
      sandboxId,
      now,
    );

    await notifyWaifuCreditWebhook(sandbox, "credits.depleted", {
      eventId: `agent-billing:${sandboxId}:credits.depleted:${sandbox.scheduled_shutdown_at.toISOString()}`,
      creditsRemaining: 0,
      requiredCredits: hourlyCost,
      scheduledShutdownAt: sandbox.scheduled_shutdown_at.toISOString(),
    });

    return { sandboxId, agentName, organizationId, action: "shutdown" };
  }

  // ── Sufficient credits — bill the hour ──────────────────────────
  const billingDescription =
    sandbox.status === "running"
      ? `Eliza agent hosting (running): ${agentName}`
      : `Eliza agent storage (idle): ${agentName}`;
  const billingResult = await agentBillingRepository.recordHourlyBilling({
    sandboxId,
    organizationId,
    userId: sandbox.user_id,
    agentName,
    sandboxStatus: sandbox.status,
    hourlyCost,
    billingDescription,
    lowCreditWarningAmount: AGENT_PRICING.LOW_CREDIT_WARNING,
    rebillCutoff: new Date(now.getTime() - REBILL_GUARD_MINUTES * 60_000),
    now,
  });

  if (billingResult.status === "already_billed_recently") {
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

  if (billingResult.status === "insufficient_credits") {
    return queueShutdownWarning();
  }

  logger.info(
    `[Agent Billing] Billed ${agentName}: $${hourlyCost.toFixed(4)}`,
    {
      sandboxId,
      newBalance: billingResult.newBalance,
      transactionId: billingResult.transactionId,
    },
  );

  if (billingResult.newBalance < AGENT_PRICING.LOW_CREDIT_WARNING) {
    await notifyWaifuCreditWebhook(sandbox, "credits.low", {
      eventId: `agent-billing:${sandboxId}:credits.low:${billingResult.transactionId}`,
      creditsRemaining: billingResult.newBalance,
      requiredCredits: hourlyCost,
    });
  }

  return {
    sandboxId,
    agentName,
    organizationId,
    action: "billed",
    amount: hourlyCost,
    newBalance: billingResult.newBalance,
  };
}

type WaifuCreditEvent = "credits.low" | "credits.depleted";

async function notifyWaifuCreditWebhook(
  sandbox: AgentBillingSandbox,
  event: WaifuCreditEvent,
  details: {
    eventId: string;
    creditsRemaining: number;
    requiredCredits: number;
    scheduledShutdownAt?: string;
  },
): Promise<void> {
  const config = recordFromUnknown(sandbox.agent_config);
  const waifuWebhook = recordFromUnknown(config.waifuWebhook);
  const webhookUrl =
    stringField(config, "webhookUrl") ?? stringField(waifuWebhook, "url");
  const webhookSecret =
    stringField(config, "webhookSecret") ??
    stringField(waifuWebhook, "secret") ??
    process.env.WAIFU_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) return;

  const timestamp = new Date().toISOString();
  const account = recordFromUnknown(config.account);
  const waifuAgentId = resolveWaifuAgentId(config);
  const body = JSON.stringify({
    event,
    timestamp,
    eventId: details.eventId,
    cloudAgentId: sandbox.id,
    elizaCloudAgentId: sandbox.id,
    agentId: waifuAgentId ?? sandbox.id,
    organizationId: sandbox.organization_id,
    tokenContractAddress: stringField(config, "tokenContractAddress"),
    tokenAddress: stringField(config, "tokenContractAddress"),
    tokenChain: stringField(config, "chain"),
    chain: stringField(config, "chain"),
    chainId: numberField(config, "chainId"),
    primaryWalletAddress: stringField(account, "primaryWalletAddress"),
    walletKeyRef: stringField(account, "walletKeyRef"),
    creditsRemaining: details.creditsRemaining,
    requiredCredits: details.requiredCredits,
    billingStatus: sandbox.billing_status,
    status: sandbox.status,
    ...(details.scheduledShutdownAt
      ? { scheduledShutdownAt: details.scheduledShutdownAt }
      : {}),
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Waifu-Webhook-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn("[Agent Billing] Waifu credit webhook failed", {
        sandboxId: sandbox.id,
        event,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn("[Agent Billing] Waifu credit webhook error", {
      sandboxId: sandbox.id,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveWaifuAgentId(config: Record<string, unknown>): string | null {
  const direct =
    stringField(config, "waifuAgentId") ??
    stringField(config, "waifu_agent_id") ??
    stringField(config, "WAIFU_AGENT_ID");
  if (direct) return direct;

  const character = recordFromUnknown(config.character);
  const characterConfig = recordFromUnknown(character.config);
  return stringField(characterConfig, "waifuAgentId") ?? stringField(characterConfig, "WAIFU_AGENT_ID");
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberField(
  data: Record<string, unknown>,
  key: string,
): number | null {
  const value = data[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
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
    const { runningSandboxes, stoppedWithBackups } =
      await agentBillingRepository.listBillableSandboxes(now, rebillCutoff);

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

    const orgs = await agentBillingRepository.listBillingOrganizations(orgIds);
    const orgMap = new Map(orgs.map((o) => [o.id, o]));

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
