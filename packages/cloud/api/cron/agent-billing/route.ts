/**
 * Bills managed-agent compute and records one durable receipt per invocation.
 *
 * The hourly processor:
 * - Charges organizations hourly for running agents ($0.01/hour)
 * - Charges for idle/stopped agents with snapshots ($0.0025/hour)
 * - Sends 48-hour shutdown warnings when credits are insufficient
 * - Shuts down agents that have been in warning state for 48+ hours
 *
 * Schedule: Runs every hour at minute 0 (0 * * * *)
 * Protected by CRON_SECRET.
 */

import { createHmac } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import {
  type AgentBillingOrganization,
  type AgentBillingSandbox,
  agentBillingRepository,
} from "@/db/repositories/agent-billing";
import { agentBillingRunRepository } from "@/db/repositories/agent-billing-runs";
import { usersRepository } from "@/db/repositories/users";
import type {
  AgentBillingRun,
  AgentBillingRunErrorSample,
  AgentBillingRunItem,
  AgentBillingRunStatus,
} from "@/db/schemas/compute-billing";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import {
  CRON_INVOCATION_ID_HEADER,
  CRON_SCHEDULE_HEADER,
  CRON_SCHEDULED_TIME_HEADER,
  getScheduledCronInvocationMetadata,
  scheduledCronInvocationId,
} from "@/lib/cron/cloudflare-cron";
import { safeFetch } from "@/lib/security/safe-fetch";
import { emailService } from "@/lib/services/email";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const REBILL_GUARD_MINUTES = 55;
const AGENT_BILLING_PATH = "/api/cron/agent-billing";
const AGENT_BILLING_SCHEDULE = "0 * * * *";
const AGENT_BILLING_RUN_LEASE_MS = 5 * 60_000;
const AGENT_BILLING_RUN_LEASE_RENEW_MS = 60_000;
const MAX_RESULT_DETAILS = 100;
const MAX_ERROR_SAMPLES = 20;

// ── Types ─────────────────────────────────────────────────────────────

interface BillingResult {
  sandboxId: string;
  agentName: string;
  organizationId: string;
  action: "billed" | "warning_sent" | "shutdown" | "skipped" | "error";
  amount?: number;
  amountDecimal?: string;
  newBalance?: number;
  transactionId?: string;
  error?: string;
}

interface RunIdentity {
  invocationKey: string;
  triggerKind: "scheduled" | "manual";
  schedule: string | null;
  scheduledAt: Date | null;
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
  now: Date,
  runAuthority: { runId: string; leaseToken: string },
): Promise<BillingResult> {
  const sandboxId = sandbox.id;
  const agentName = sandbox.agent_name ?? sandboxId.slice(0, 8);
  const organizationId = sandbox.organization_id;
  const hourlyRate = getHourlyRate(sandbox.status);
  const currentBalance = Number(org.credit_balance);
  const periodStart =
    sandbox.last_billed_at ??
    new Date(
      Math.max(
        sandbox.created_at?.getTime() ?? now.getTime() - 60 * 60 * 1000,
        now.getTime() - 60 * 60 * 1000,
      ),
    );
  const amountDue =
    hourlyRate * ((now.getTime() - periodStart.getTime()) / (60 * 60 * 1000));

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
    if (liveBalance >= amountDue) {
      logger.info(
        `[Agent Billing] Skipping shutdown warning for ${agentName}; balance recovered before warning`,
        {
          sandboxId,
          amountDue,
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

    const warningScheduled =
      await agentBillingRepository.scheduleShutdownWarningForRun({
        ...runAuthority,
        sandboxId,
        organizationId,
        agentName,
        now,
        shutdownTime,
      });
    if (!warningScheduled) {
      return {
        sandboxId,
        agentName,
        organizationId,
        action: "skipped",
        error: "Shutdown warning was no longer applicable",
      };
    }

    const recipientEmail =
      org.billing_email || (await getOrgUserEmail(organizationId));
    if (recipientEmail) {
      // Reuse the container shutdown warning email template — content is generic enough
      let sent: boolean;
      try {
        sent = await emailService.sendContainerShutdownWarningEmail({
          email: recipientEmail,
          organizationName: org.name,
          containerName: `Agent Agent: ${agentName}`,
          projectName: "Eliza Cloud",
          dailyCost: hourlyRate * 24,
          monthlyCost: hourlyRate * 24 * 30,
          currentBalance: liveBalance,
          requiredCredits: amountDue,
          minimumRecommended: hourlyRate * 24 * 7, // 1 week
          shutdownTime: shutdownTime.toLocaleString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          }),
          billingUrl: `${appUrl}/cloud/billing`,
          dashboardUrl: `${appUrl}/cloud/agents`,
        });
      } catch (cause) {
        // error-policy:J2 provider failure gains stable billing context while
        // preserving the original rejection for the outer J1 boundary.
        throw new ElizaError("Shutdown warning email failed", {
          code: "AGENT_BILLING_WARNING_EMAIL_FAILED",
          cause,
          context: { sandboxId, organizationId },
          severity: "ephemeral",
        });
      }
      if (!sent) {
        throw new ElizaError(
          "Shutdown warning email was not accepted by the provider",
          {
            code: "AGENT_BILLING_WARNING_EMAIL_NOT_ACCEPTED",
            context: { sandboxId, organizationId },
            severity: "ephemeral",
          },
        );
      }

      logger.info(
        `[Agent Billing] Sent shutdown warning for ${agentName} to ${recipientEmail}`,
      );
    }

    await notifyWaifuCreditWebhook(sandbox, "credits.low", {
      eventId: `agent-billing:${sandboxId}:credits.low:${now.toISOString()}`,
      creditsRemaining: liveBalance,
      requiredCredits: amountDue,
      scheduledShutdownAt: shutdownTime.toISOString(),
    });

    return {
      sandboxId,
      agentName,
      organizationId,
      action: "warning_sent",
      amount: amountDue,
    };
  }

  logger.info(`[Agent Billing] Processing ${agentName}`, {
    sandboxId,
    hourlyRate,
    amountDue,
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

    await provisioningJobService.enqueueAgentSuspendOnce({
      agentId: sandboxId,
      organizationId,
      userId: sandbox.user_id,
      authorization: "billing_request",
    });

    await notifyWaifuCreditWebhook(sandbox, "credits.depleted", {
      eventId: `agent-billing:${sandboxId}:credits.depleted:${sandbox.scheduled_shutdown_at.toISOString()}`,
      creditsRemaining: 0,
      requiredCredits: amountDue,
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
    ...runAuthority,
    sandboxId,
    organizationId,
    userId: sandbox.user_id,
    agentName,
    hourlyRate,
    billingDescription,
    lowCreditWarningAmount: AGENT_PRICING.LOW_CREDIT_WARNING,
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
    `[Agent Billing] Billed ${agentName}: $${billingResult.amount.toFixed(6)}`,
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
      requiredCredits: billingResult.amount,
    });
  }

  return {
    sandboxId,
    agentName,
    organizationId,
    action: "billed",
    amount: billingResult.amount,
    amountDecimal: billingResult.amountDecimal,
    newBalance: billingResult.newBalance,
    transactionId: billingResult.transactionId,
  };
}

function resultFromRunItem(item: AgentBillingRunItem): BillingResult {
  return {
    sandboxId: item.sandbox_id,
    agentName: item.agent_name,
    organizationId: item.organization_id,
    action: item.action,
    ...(item.action === "billed"
      ? {
          amount: Number(item.amount),
          amountDecimal: item.amount,
          newBalance:
            item.new_balance === null ? undefined : Number(item.new_balance),
          transactionId: item.transaction_id ?? undefined,
        }
      : {}),
    ...(item.detail_message ? { error: item.detail_message } : {}),
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
    process.env.ELIZA_CLOUD_WEBHOOK_SECRET ??
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
    // SECURITY (#9853): webhookUrl is DB-stored per-agent config — IP-pin it so
    // a malicious receiver URL can't pivot into internal/metadata networks.
    const response = await safeFetch(webhookUrl, {
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
  return (
    stringField(characterConfig, "waifuAgentId") ??
    stringField(characterConfig, "WAIFU_AGENT_ID")
  );
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

function resolveRunIdentity(c: AppContext): RunIdentity {
  const schedulerMetadata = getScheduledCronInvocationMetadata(c.req.raw);
  const invocationId = c.req.header(CRON_INVOCATION_ID_HEADER);
  const schedule = c.req.header(CRON_SCHEDULE_HEADER);
  const scheduledTimeText = c.req.header(CRON_SCHEDULED_TIME_HEADER);
  const supplied = [invocationId, schedule, scheduledTimeText].filter(
    (value) => value !== undefined,
  ).length;

  if (schedulerMetadata === null && supplied === 0) {
    return {
      invocationKey: `manual:agent-billing:${crypto.randomUUID()}`,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
    };
  }
  if (schedulerMetadata === null) {
    throw ValidationError(
      "Scheduled billing identity is restricted to the internal scheduler",
    );
  }
  if (
    supplied !== 3 ||
    invocationId === undefined ||
    schedule === undefined ||
    scheduledTimeText === undefined
  ) {
    throw ValidationError(
      "Scheduled billing identity headers must be supplied together",
    );
  }
  if (schedule !== AGENT_BILLING_SCHEDULE) {
    throw ValidationError("Scheduled billing identity has the wrong schedule");
  }
  if (!/^(0|[1-9]\d*)$/.test(scheduledTimeText)) {
    throw ValidationError(
      "Scheduled billing time must be canonical epoch milliseconds",
    );
  }
  const scheduledTime = Number(scheduledTimeText);
  if (
    !Number.isSafeInteger(scheduledTime) ||
    !Number.isFinite(new Date(scheduledTime).getTime())
  ) {
    throw ValidationError(
      "Scheduled billing time is outside the supported range",
    );
  }
  const expectedInvocationId = scheduledCronInvocationId(
    {
      cron: schedulerMetadata.schedule,
      scheduledTime: schedulerMetadata.scheduledTime,
    },
    AGENT_BILLING_PATH,
  );
  if (
    schedulerMetadata.path !== AGENT_BILLING_PATH ||
    schedulerMetadata.schedule !== schedule ||
    schedulerMetadata.scheduledTime !== scheduledTime ||
    schedulerMetadata.invocationId !== invocationId ||
    invocationId !== expectedInvocationId
  ) {
    throw ValidationError("Scheduled billing invocation identity is invalid");
  }
  return {
    invocationKey: invocationId,
    triggerKind: "scheduled",
    schedule,
    scheduledAt: new Date(scheduledTime),
  };
}

function canonicalRevenueMicros(value: string): bigint {
  const match = /^(0|[1-9]\d{0,9})\.(\d{6})$/.exec(value);
  if (!match)
    throw new ElizaError("Billing repository returned a non-canonical amount", {
      code: "INVALID_AGENT_BILLING_AMOUNT",
      context: { value },
      severity: "fatal",
    });
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt(match[2] ?? "0");
}

function formatRevenueMicros(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, "0");
  return `${whole}.${fraction}`;
}

function terminalStatus(
  processed: number,
  errors: number,
): Exclude<AgentBillingRunStatus, "started"> {
  if (processed === 0) return "empty";
  if (errors === 0) return "succeeded";
  return errors === processed ? "failed" : "partial_failure";
}

function responseForRun(
  c: AppContext,
  run: AgentBillingRun,
  options: { replayed: boolean; results?: BillingResult[] } = {
    replayed: false,
  },
): Response {
  const success = run.status === "empty" || run.status === "succeeded";
  const data = {
    runId: run.id,
    invocationKey: run.invocation_key,
    triggerKind: run.trigger_kind,
    schedule: run.schedule,
    scheduledAt: run.scheduled_at?.toISOString() ?? null,
    status: run.status,
    attemptCount: run.attempt_count,
    billingCutoffAt: run.billing_cutoff_at.toISOString(),
    sandboxesProcessed: run.sandboxes_processed,
    sandboxesBilled: run.sandboxes_billed,
    warningsSent: run.warnings_sent,
    sandboxesShutdown: run.sandboxes_shutdown,
    totalRevenue: run.total_revenue,
    errors: run.errors,
    duration: run.duration_ms,
    completedAt: run.completed_at?.toISOString() ?? null,
    replayed: options.replayed,
    ...(options.results
      ? {
          resultsTruncated: options.results.length > MAX_RESULT_DETAILS,
          results: options.results.slice(0, MAX_RESULT_DETAILS),
        }
      : {}),
  };

  if (run.status === "started") {
    return c.json(
      {
        success: false,
        error: "Agent billing run is already in progress",
        code: "billing_run_in_progress",
        runId: run.id,
        invocationKey: run.invocation_key,
        data,
      },
      409,
    );
  }
  if (!success) {
    return c.json(
      {
        success: false,
        error:
          run.status === "partial_failure"
            ? "Agent billing run completed with sandbox failures"
            : "Agent billing run failed",
        code: "agent_billing_run_failed",
        runId: run.id,
        invocationKey: run.invocation_key,
        data,
      },
      500,
    );
  }
  return c.json({
    success: true,
    runId: run.id,
    invocationKey: run.invocation_key,
    data,
  });
}

// ── Main Handler ──────────────────────────────────────────────────────

async function handleAgentBilling(c: AppContext): Promise<Response> {
  const invocationStartedAtMs = Date.now();
  let run: AgentBillingRun | null = null;
  let leaseToken: string | null = null;
  let nextLeaseRenewalAt = invocationStartedAtMs;
  let sandboxesProcessed = 0;
  let sandboxesBilled = 0;
  let warningsSent = 0;
  let sandboxesShutdown = 0;
  let errors = 0;
  let revenueMicros = 0n;
  const errorSamples: AgentBillingRunErrorSample[] = [];
  const processedSandboxIds = new Set<string>();
  const results: BillingResult[] = [];

  function applyRunItem(item: AgentBillingRunItem): BillingResult {
    const result = resultFromRunItem(item);
    if (processedSandboxIds.has(item.sandbox_id)) return result;
    processedSandboxIds.add(item.sandbox_id);
    // Keep at most one sentinel beyond the response limit so the truncation
    // flag remains exact without retaining an unbounded sweep in memory.
    if (results.length <= MAX_RESULT_DETAILS) results.push(result);
    sandboxesProcessed++;
    if (item.action === "billed") {
      revenueMicros += canonicalRevenueMicros(item.amount);
      sandboxesBilled++;
    } else if (item.action === "warning_sent") {
      warningsSent++;
    } else if (item.action === "shutdown") {
      sandboxesShutdown++;
    } else if (item.action === "error") {
      errors++;
      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({
          code: item.detail_code ?? "sandbox_processing_failed",
          message: item.detail_message ?? "Sandbox billing processing failed",
          sandboxId: item.sandbox_id,
        });
      }
    }
    return result;
  }

  async function renewRunLease(force = false): Promise<void> {
    if (!run || !leaseToken || run.status !== "started") {
      throw new ElizaError("Agent billing run has no active lease capability", {
        code: "AGENT_BILLING_RUN_LEASE_MISSING",
        context: { runId: run?.id ?? null, status: run?.status ?? null },
        severity: "fatal",
      });
    }
    const nowMs = Date.now();
    if (!force && nowMs < nextLeaseRenewalAt) return;
    run = await agentBillingRunRepository.renewLease(
      run.id,
      leaseToken,
      AGENT_BILLING_RUN_LEASE_MS,
    );
    nextLeaseRenewalAt = nowMs + AGENT_BILLING_RUN_LEASE_RENEW_MS;
  }

  try {
    requireCronSecret(c);
    const identity = resolveRunIdentity(c);
    const claim = await agentBillingRunRepository.startOrLoad({
      ...identity,
      leaseDurationMs: AGENT_BILLING_RUN_LEASE_MS,
    });
    run = claim.run;
    if (!claim.claimed) return responseForRun(c, run, { replayed: true });
    leaseToken = claim.leaseToken;
    if (!leaseToken) {
      throw new ElizaError(
        "Claimed agent billing run omitted its lease capability",
        {
          code: "AGENT_BILLING_RUN_LEASE_MISSING",
          context: { runId: run.id, claimed: claim.claimed },
          severity: "fatal",
        },
      );
    }

    const now = run.billing_cutoff_at;
    const rebillCutoff = new Date(
      now.getTime() - REBILL_GUARD_MINUTES * 60_000,
    );
    const appUrl = c.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";

    logger.info("[Agent Billing] Starting hourly billing run", {
      runId: run.id,
      invocationKey: run.invocation_key,
      triggerKind: run.trigger_kind,
      recovered: claim.recovered,
      attemptCount: run.attempt_count,
    });
    await renewRunLease(true);
    for (const item of await agentBillingRunRepository.listItems(run.id)) {
      applyRunItem(item);
    }
    // ── 1. Running agents (always billed) ───────────────────────────
    const { runningSandboxes, stoppedWithBackups } =
      await agentBillingRepository.listBillableSandboxes(now, rebillCutoff);

    const allBillable = [...runningSandboxes, ...stoppedWithBackups].filter(
      (sandbox) => !processedSandboxIds.has(sandbox.id),
    );
    if (runningSandboxes.length + stoppedWithBackups.length === 0) {
      logger.info("[Agent Billing] No billable sandboxes", {
        runId: run.id,
        invocationKey: run.invocation_key,
      });
    }

    logger.info(
      `[Agent Billing] Processing ${allBillable.length} sandboxes (${runningSandboxes.length} running, ${stoppedWithBackups.length} idle)`,
    );

    // ── Fetch organizations ─────────────────────────────────────────
    const orgIds = [...new Set(allBillable.map((s) => s.organization_id))];

    const orgs = await agentBillingRepository.listBillingOrganizations(orgIds);
    const orgMap = new Map(orgs.map((o) => [o.id, o]));

    for (const sandbox of allBillable) {
      await renewRunLease();
      const org = orgMap.get(sandbox.organization_id);
      if (!org) {
        const { item } = await agentBillingRunRepository.recordItem(
          { runId: run.id, leaseToken },
          {
            sandboxId: sandbox.id,
            organizationId: sandbox.organization_id,
            agentName: sandbox.agent_name ?? "unknown",
            action: "error",
            detailCode: "organization_not_found",
            detailMessage: "Billing organization was not found",
            completedAt: new Date(),
          },
        );
        applyRunItem(item);
        continue;
      }

      try {
        const result = await processSandboxBilling(sandbox, org, appUrl, now, {
          runId: run.id,
          leaseToken,
        });
        if (result.action === "billed") {
          if (
            !result.amountDecimal ||
            result.newBalance === undefined ||
            !result.transactionId
          ) {
            throw new ElizaError(
              "Billed outcome omitted its durable financial evidence",
              {
                code: "INVALID_AGENT_BILLING_FINANCIAL_EVIDENCE",
                context: {
                  sandboxId: result.sandboxId,
                  hasAmount: Boolean(result.amountDecimal),
                  hasBalance: result.newBalance !== undefined,
                  hasTransactionId: Boolean(result.transactionId),
                },
                severity: "fatal",
              },
            );
          }
          canonicalRevenueMicros(result.amountDecimal);
        }
        const { item } = await agentBillingRunRepository.recordItem(
          { runId: run.id, leaseToken },
          {
            sandboxId: result.sandboxId,
            organizationId: result.organizationId,
            agentName: result.agentName,
            action: result.action,
            ...(result.action === "billed"
              ? {
                  amountDecimal: result.amountDecimal,
                  newBalanceDecimal: String(result.newBalance),
                  transactionId: result.transactionId,
                }
              : {}),
            ...(result.action === "error"
              ? {
                  detailCode: "sandbox_processing_failed",
                  detailMessage: "Sandbox billing processing failed",
                }
              : result.action === "skipped" && result.error
                ? {
                    detailCode: "skipped",
                    detailMessage: result.error,
                  }
                : {}),
            completedAt: new Date(),
          },
        );
        const durableResult = applyRunItem(item);

        if (durableResult.action === "billed") {
          // Update org balance in memory for next sandbox in same org
          org.credit_balance = String(durableResult.newBalance);
        } else if (durableResult.action === "warning_sent") {
          // Refresh in-memory balance after warning (balance may have changed)
          const freshBalance = await getOrgBalance(org.id);
          if (freshBalance !== null) org.credit_balance = String(freshBalance);
        } else if (durableResult.action === "shutdown") {
          // Refresh in-memory balance after shutdown action
          const freshBalance = await getOrgBalance(org.id);
          if (freshBalance !== null) org.credit_balance = String(freshBalance);
        }
      } catch (error) {
        // error-policy:J1 per-sandbox boundary translation — committed sibling
        // debits remain authoritative while this run records an explicit,
        // sanitized partial failure and continues the bounded sweep.
        logger.error(
          `[Agent Billing] Error processing sandbox ${sandbox.agent_name ?? sandbox.id}`,
          {
            sandboxId: sandbox.id,
            errorType: error instanceof Error ? error.name : typeof error,
          },
        );
        const { item } = await agentBillingRunRepository.recordItem(
          { runId: run.id, leaseToken },
          {
            sandboxId: sandbox.id,
            organizationId: sandbox.organization_id,
            agentName: sandbox.agent_name ?? "unknown",
            action: "error",
            detailCode: "sandbox_processing_failed",
            detailMessage: "Sandbox billing processing failed",
            completedAt: new Date(),
          },
        );
        applyRunItem(item);
      }
    }

    const totalRevenue = formatRevenueMicros(revenueMicros);
    const status = terminalStatus(sandboxesProcessed, errors);
    await renewRunLease(true);
    const completion = await agentBillingRunRepository.complete(
      run.id,
      leaseToken,
      {
        status,
        sandboxesProcessed,
        sandboxesBilled,
        warningsSent,
        sandboxesShutdown,
        errors,
        totalRevenue,
        errorSamples,
      },
    );
    run = completion.run;

    logger.info("[Agent Billing] Completed hourly billing run", {
      runId: run.id,
      invocationKey: run.invocation_key,
      status: run.status,
      sandboxesProcessed,
      sandboxesBilled,
      warningsSent,
      sandboxesShutdown,
      totalRevenue,
      errors,
      duration: run.duration_ms,
    });

    return responseForRun(
      c,
      run,
      completion.completedByCaller
        ? { replayed: false, results }
        : { replayed: true },
    );
  } catch (error) {
    // error-policy:J1 route boundary for the cron/ dir — the outermost handler
    // catch translates exceptions into a structured HTTP failure
    // (failureResponse → 5xx / typed status), never a fabricated success. Per-item
    // failures inside the sweep are isolated and reported in the result summary.
    logger.error("[Agent Billing] Failed", {
      runId: run?.id,
      invocationKey: run?.invocation_key,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    if (run?.status === "started") {
      try {
        const failedSamples = [
          ...errorSamples.slice(0, MAX_ERROR_SAMPLES - 1),
          {
            code: "billing_run_failed",
            message: "Agent billing run failed",
          },
        ];
        if (!leaseToken) {
          throw new ElizaError(
            "Failed agent billing run omitted its lease capability",
            {
              code: "AGENT_BILLING_RUN_LEASE_MISSING",
              context: { runId: run.id, status: run.status },
              severity: "fatal",
            },
          );
        }
        const completion = await agentBillingRunRepository.complete(
          run.id,
          leaseToken,
          {
            status: "failed",
            sandboxesProcessed,
            sandboxesBilled,
            warningsSent,
            sandboxesShutdown,
            errors: errors + 1,
            totalRevenue: formatRevenueMicros(revenueMicros),
            errorSamples: failedSamples,
          },
        );
        run = completion.run;
        return responseForRun(c, run, {
          replayed: completion.terminalReplay,
        });
      } catch (receiptError) {
        // error-policy:J1 route boundary translation — failure to finalize the
        // durable receipt itself must fail closed and can never become 2xx.
        logger.error("[Agent Billing] Failed to finalize run receipt", {
          runId: run.id,
          errorType:
            receiptError instanceof Error
              ? receiptError.name
              : typeof receiptError,
        });
      }
    }
    return failureResponse(c, error);
  }
}

const app = new Hono<AppEnv>();
app.get("/", (c) => handleAgentBilling(c));
app.post("/", (c) => handleAgentBilling(c));
export default app;
