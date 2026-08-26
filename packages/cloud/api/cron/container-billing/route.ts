/**
 * Container Billing Cron Job
 *
 * Daily billing processor for running containers.
 * - Charges organizations daily for their running containers ($0.67/day per container)
 * - Sends 48-hour shutdown warnings when credits are insufficient
 * - Shuts down containers that have been in warning state for 48+ hours
 *
 * Schedule: Runs daily at midnight UTC (0 0 * * *)
 * Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { usersRepository } from "@/db/repositories";
import {
  type BillableContainer,
  type ContainerBillingOrganization,
  containerBillingRepository,
} from "@/db/repositories/container-billing";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import {
  CONTAINER_PRICING,
  calculateDailyContainerCost,
} from "@/lib/constants/pricing";
import { computeContainerBillingPlan } from "@/lib/services/container-billing-policy";
import {
  enqueueContainerStopOnce,
  listRecoverableContainerStopIntents,
  rearmRecoverableContainerStopIntentOnce,
} from "@/lib/services/container-stop-job-service";
import { emailService } from "@/lib/services/email";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

interface BillingResult {
  containerId: string;
  containerName: string;
  organizationId: string;
  action: "billed" | "warning_sent" | "shutdown" | "skipped" | "error";
  amount?: number;
  newBalance?: number;
  /** Portion of `amount` paid from owner's redeemable_earnings (pay-as-you-go). */
  paidFromEarnings?: number;
  error?: string;
}

/**
 * Process daily billing for a single container
 */
/**
 * Find the user whose redeemable_earnings fund this org's containers.
 * Mirrors the rule used elsewhere: prefer role='owner', fall back to
 * the earliest member.
 */
async function findEarningsSourceUserId(
  organizationId: string,
): Promise<string | null> {
  const members = await usersRepository.listByOrganization(organizationId);
  if (members.length === 0) return null;
  const owner = members.find((m) => m.role === "owner");
  if (owner) return owner.id;
  const validMembers = members.filter(
    (member) =>
      member.created_at instanceof Date &&
      Number.isFinite(member.created_at.getTime()),
  );
  if (validMembers.length === 0) return null;
  return validMembers
    .slice()
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0].id;
}

async function getAvailableEarnings(userId: string): Promise<number> {
  const balance = await redeemableEarningsService.getBalance(userId);
  return balance?.availableBalance ?? 0;
}

async function processContainerBilling(
  container: BillableContainer,
  org: ContainerBillingOrganization & {
    earnings_source_user_id: string | null;
    earnings_available: number;
  },
  appUrl: string,
  now: Date,
): Promise<BillingResult> {
  const containerId = container.id;
  const containerName = container.name;
  const organizationId = container.organization_id;

  const dailyRate = calculateDailyContainerCost({
    desiredCount: container.desired_count,
    cpu: container.cpu,
    memory: container.memory,
  });

  const periodStart =
    container.last_billed_at ??
    new Date(
      Math.max(
        container.created_at?.getTime() ?? now.getTime() - 24 * 60 * 60 * 1000,
        now.getTime() - 24 * 60 * 60 * 1000,
      ),
    );
  const periodEnd = now;
  const dailyCost =
    dailyRate *
    ((periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000));
  const currentBalance = Number(org.credit_balance);
  const plan = computeContainerBillingPlan({
    dailyCost,
    currentBalance,
    ownerEarningsAvailable: org.earnings_available,
    payAsYouGoFromEarnings: org.pay_as_you_go_from_earnings,
  });
  const earningsAvailable = plan.earningsEligible;
  const totalAvailable = plan.totalAvailable;
  logger.info(`[Container Billing] Processing ${containerName}`, {
    containerId,
    dailyCost,
    currentBalance,
    earningsAvailable,
    totalAvailable,
    billingStatus: container.billing_status,
  });

  // Check if container is already scheduled for shutdown and time has passed
  if (
    container.billing_status === "shutdown_pending" &&
    container.scheduled_shutdown_at &&
    new Date(container.scheduled_shutdown_at) <= now
  ) {
    // Time to shut down the container
    logger.info(
      `[Container Billing] Shutting down container ${containerName} due to insufficient credits`,
    );

    // The durable, tenant-bound stop request remains independently recoverable.
    // Billing stays shutdown_pending until the daemon proves the provider
    // runtime absent; a failed/terminal provider call therefore cannot hide a
    // still-live workload from this cron's ordinary scan.
    const stopRequest = await enqueueContainerStopOnce({
      containerId,
      organizationId,
      userId: container.user_id,
    });
    if (!stopRequest.requested) {
      return {
        containerId,
        containerName,
        organizationId,
        action: "skipped",
        error: "Funding restored before provider stop",
      };
    }

    return {
      containerId,
      containerName,
      organizationId,
      action: "shutdown",
    };
  }

  // Check if we have enough across both pools (earnings + credits)
  if (totalAvailable < dailyCost) {
    // Insufficient total - check if we need to send warning
    if (
      container.billing_status === "active" ||
      !container.shutdown_warning_sent_at
    ) {
      // Send 48-hour warning and schedule shutdown
      const shutdownTime = new Date(
        now.getTime() +
          CONTAINER_PRICING.SHUTDOWN_WARNING_HOURS * 60 * 60 * 1000,
      );

      const warningScheduled =
        await containerBillingRepository.scheduleShutdownWarning(
          containerId,
          organizationId,
          now,
          shutdownTime,
        );
      if (!warningScheduled) {
        return {
          containerId,
          containerName,
          organizationId,
          action: "skipped",
          error: "Container state changed before shutdown warning",
        };
      }

      // Send warning email
      const recipientEmail =
        org.billing_email || (await getOrgUserEmail(organizationId));
      if (recipientEmail) {
        await emailService.sendContainerShutdownWarningEmail({
          email: recipientEmail,
          organizationName: org.name,
          containerName: containerName,
          projectName: container.project_name,
          dailyCost,
          monthlyCost: CONTAINER_PRICING.MONTHLY_BASE_COST,
          currentBalance: totalAvailable,
          requiredCredits: dailyCost,
          minimumRecommended: dailyCost * 7, // 1 week
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
          dashboardUrl: `${appUrl}/cloud/containers/${containerId}`,
        });

        logger.info(
          `[Container Billing] Sent shutdown warning for ${containerName} to ${recipientEmail}`,
        );
      }

      // Record the billing failure
      await containerBillingRepository.recordBillingFailure({
        containerId,
        organizationId,
        amount: dailyCost,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        errorMessage: `Insufficient funds: required $${dailyCost.toFixed(2)}, available $${totalAvailable.toFixed(4)} (credits $${currentBalance.toFixed(4)} + earnings $${earningsAvailable.toFixed(4)})`,
      });

      return {
        containerId,
        containerName,
        organizationId,
        action: "warning_sent",
        amount: dailyCost,
      };
    }

    // Warning already sent, waiting for shutdown
    return {
      containerId,
      containerName,
      organizationId,
      action: "skipped",
      error: "Waiting for scheduled shutdown",
    };
  }

  // The repository locks the workload, tenant balance, and optional earnings
  // balance and commits both ledgers, the receipt, and lifecycle cursor in one
  // transaction. No route-level conversion can escape without its charge.
  const billingResult =
    await containerBillingRepository.recordSuccessfulDailyBilling({
      containerId,
      organizationId,
      userId: container.user_id,
      containerName,
      dailyRate,
      earningsSourceUserId: org.earnings_source_user_id,
      payAsYouGoFromEarnings: org.pay_as_you_go_from_earnings,
      dailyCost,
      fromEarnings: plan.fromEarnings,
      fromCredits: plan.fromCredits,
      newBalance: currentBalance,
      now,
    });

  // The row-lock guard found this period already billed (e.g. an overlapping
  // cron run committed first). Earnings were not converted here either — the
  // idempotency key short-circuited convertToCredits — so nothing was charged.
  if (billingResult.alreadyBilled) {
    logger.info(
      `[Container Billing] Skipped ${containerName}: already billed this period`,
      { containerId },
    );
    return {
      containerId,
      containerName,
      organizationId,
      action: "skipped",
      error: "Already billed this period",
    };
  }

  if (billingResult.insufficient) {
    const shutdownTime = new Date(
      now.getTime() + CONTAINER_PRICING.SHUTDOWN_WARNING_HOURS * 60 * 60 * 1000,
    );
    const warningScheduled =
      await containerBillingRepository.scheduleShutdownWarning(
        containerId,
        organizationId,
        now,
        shutdownTime,
      );
    if (!warningScheduled) {
      return {
        containerId,
        containerName,
        organizationId,
        action: "skipped",
        error: "Container state changed before shutdown warning",
      };
    }
    return {
      containerId,
      containerName,
      organizationId,
      action: "warning_sent",
      amount: billingResult.amount ?? dailyCost,
    };
  }

  const billedAmount = billingResult.amount ?? dailyCost;
  const billedFromEarnings = billingResult.fromEarnings ?? 0;

  logger.info(
    `[Container Billing] Billed ${containerName}: $${billedAmount.toFixed(6)} (earnings $${billedFromEarnings.toFixed(6)})`,
    {
      containerId,
      newBalance: billingResult.newBalance,
      transactionId: billingResult.transactionId,
    },
  );

  return {
    containerId,
    containerName,
    organizationId,
    action: "billed",
    amount: billedAmount,
    paidFromEarnings: billedFromEarnings,
    newBalance: billingResult.newBalance,
  };
}

/**
 * Get email for organization user (fallback when billing_email not set)
 */
async function getOrgUserEmail(organizationId: string): Promise<string | null> {
  try {
    const users = await usersRepository.listByOrganization(organizationId);
    return users.length > 0 && users[0].email ? users[0].email : null;
  } catch (error) {
    logger.error(`[Container Billing] Failed to get org user email`, {
      organizationId,
      error,
    });
    return null;
  }
}

/**
 * Main billing handler
 */
async function handleContainerBilling(c: AppContext): Promise<Response> {
  const startTime = Date.now();
  try {
    requireCronSecret(c);
    const appUrl = c.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
    // One timestamp for the whole run: the due-gate, the period, and the
    // row-lock idempotency guard must all agree on "now".
    const runNow = new Date();

    logger.info("[Container Billing] Starting daily container billing run");
    // Provider-confirmed rows are deliberately excluded from ordinary billing
    // discovery. Recover their durable jobs through this independent scan so a
    // failed terminal job cannot become orphaned once the container is fenced
    // suspended. Per-intent failures are isolated; a later cron can retry.
    let recoveryJobsRequested = 0;
    let recoverableStopIntents: Awaited<
      ReturnType<typeof listRecoverableContainerStopIntents>
    > = [];
    try {
      recoverableStopIntents =
        await listRecoverableContainerStopIntents(runNow);
    } catch (error) {
      logger.error(
        "[Container Billing] Failed to scan recoverable container stops",
        { error },
      );
    }
    for (const intent of recoverableStopIntents) {
      try {
        await rearmRecoverableContainerStopIntentOnce({
          intentId: intent.id,
          containerId: intent.container_id,
          organizationId: intent.organization_id,
          lifecycleRevision: intent.lifecycle_revision,
          now: runNow,
        });
        recoveryJobsRequested += 1;
      } catch (error) {
        logger.error(
          "[Container Billing] Failed to rearm recoverable container stop",
          {
            intentId: intent.id,
            containerId: intent.container_id,
            organizationId: intent.organization_id,
            error,
          },
        );
      }
    }

    // Get all running containers that need billing (and are actually due).
    const runningContainers =
      await containerBillingRepository.listBillableContainers(runNow);

    if (runningContainers.length === 0) {
      if (recoveryJobsRequested > 0) {
        void provisioningJobService.triggerImmediate(c.env).catch(() => {});
      }
      logger.info("[Container Billing] No running containers to bill");
      return c.json({
        success: true,
        data: {
          containersProcessed: 0,
          containersBilled: 0,
          warningsSent: 0,
          containersShutdown: 0,
          totalRevenue: 0,
          errors: 0,
          duration: Date.now() - startTime,
        },
      });
    }

    logger.info(
      `[Container Billing] Processing ${runningContainers.length} containers`,
    );

    // Get all unique organization IDs
    const orgIds = [
      ...new Set(runningContainers.map((c) => c.organization_id)),
    ];

    const orgs =
      await containerBillingRepository.listBillingOrganizations(orgIds);

    // Resolve each org's earnings source user + their available balance once
    // so we don't query inside the per-container loop.
    const earningsByOrg = new Map<
      string,
      { sourceUserId: string | null; available: number }
    >();
    for (const orgId of orgIds) {
      const sourceUserId = await findEarningsSourceUserId(orgId);
      const available = sourceUserId
        ? await getAvailableEarnings(sourceUserId)
        : 0;
      earningsByOrg.set(orgId, { sourceUserId, available });
    }

    const orgMap = new Map(
      orgs.map((o) => {
        const earnings = earningsByOrg.get(o.id) ?? {
          sourceUserId: null,
          available: 0,
        };
        return [
          o.id,
          {
            ...o,
            earnings_source_user_id: earnings.sourceUserId,
            earnings_available: earnings.available,
          },
        ];
      }),
    );

    // Process each container
    const results: BillingResult[] = [];
    let totalRevenue = 0;
    let containersBilled = 0;
    let warningsSent = 0;
    let containersShutdown = 0;
    let errors = 0;

    for (const container of runningContainers) {
      const org = orgMap.get(container.organization_id);
      if (!org) {
        results.push({
          containerId: container.id,
          containerName: container.name,
          organizationId: container.organization_id,
          action: "error",
          error: "Organization not found",
        });
        errors++;
        continue;
      }

      try {
        const result = await processContainerBilling(
          container,
          org,
          appUrl,
          runNow,
        );
        results.push(result);

        if (result.action === "billed" && result.amount) {
          totalRevenue += result.amount;
          containersBilled++;
          // Update in-memory pools so subsequent containers in the same
          // org see the post-debit state (credits down, earnings down).
          org.credit_balance = String(result.newBalance);
          org.earnings_available = Math.max(
            0,
            org.earnings_available - (result.paidFromEarnings ?? 0),
          );
        } else if (result.action === "warning_sent") {
          warningsSent++;
        } else if (result.action === "shutdown") {
          containersShutdown++;
        } else if (result.action === "error") {
          errors++;
        }
      } catch (error) {
        logger.error(
          `[Container Billing] Error processing container ${container.name}`,
          { error },
        );
        results.push({
          containerId: container.id,
          containerName: container.name,
          organizationId: container.organization_id,
          action: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        errors++;
      }
    }

    // Kick the provisioning-worker daemon so any CONTAINER_STOP jobs enqueued
    // above run now instead of waiting for the next process-provisioning-jobs
    // tick. Fire-and-forget — the daemon's own cron is the safety net.
    if (containersShutdown > 0 || recoveryJobsRequested > 0) {
      // error-policy:J5 fire-and-forget daemon kick — a failed trigger is
      // recovered by the provisioning worker's own cron (the safety net named in
      // the comment above), which is where the rejection is effectively observed.
      void provisioningJobService.triggerImmediate(c.env).catch(() => {});
    }

    const duration = Date.now() - startTime;

    logger.info("[Container Billing] Completed daily billing run", {
      containersProcessed: results.length,
      containersBilled,
      warningsSent,
      containersShutdown,
      totalRevenue: totalRevenue.toFixed(2),
      errors,
      duration,
    });

    return c.json({
      success: true,
      data: {
        containersProcessed: results.length,
        containersBilled,
        warningsSent,
        containersShutdown,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        errors,
        duration,
        timestamp: new Date().toISOString(),
        results: results.slice(0, 100),
      },
    });
  } catch (error) {
    logger.error("[Container Billing] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
}

const app = new Hono<AppEnv>();
app.get("/", (c) => handleContainerBilling(c));
app.post("/", (c) => handleContainerBilling(c));
export default app;
