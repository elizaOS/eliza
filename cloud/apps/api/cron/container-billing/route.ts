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

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead, dbWrite } from "@/db/client";
import { usersRepository } from "@/db/repositories";
import { containerBillingRecords, containers } from "@/db/schemas/containers";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { organizationBilling } from "@/db/schemas/organization-billing";
import { organizations } from "@/db/schemas/organizations";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { CONTAINER_PRICING, calculateDailyContainerCost } from "@/lib/constants/pricing";
import { emailService } from "@/lib/services/email";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

// Billing status types
type BillingStatus = "active" | "warning" | "suspended" | "shutdown_pending";

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
async function findEarningsSourceUserId(organizationId: string): Promise<string | null> {
  const members = await usersRepository.listByOrganization(organizationId);
  if (members.length === 0) return null;
  const owner = members.find((m) => m.role === "owner");
  if (owner) return owner.id;
  return members.slice().sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0].id;
}

async function getAvailableEarnings(userId: string): Promise<number> {
  const balance = await redeemableEarningsService.getBalance(userId);
  return balance?.availableBalance ?? 0;
}

async function processContainerBilling(
  container: {
    id: string;
    name: string;
    project_name: string;
    organization_id: string;
    user_id: string;
    status: string;
    billing_status: string;
    desired_count: number;
    cpu: number;
    memory: number;
    shutdown_warning_sent_at: Date | null;
    scheduled_shutdown_at: Date | null;
    total_billed: string;
  },
  org: {
    id: string;
    name: string;
    credit_balance: string;
    billing_email: string | null;
    earnings_source_user_id: string | null;
    earnings_available: number;
    pay_as_you_go_from_earnings: boolean;
  },
  appUrl: string,
): Promise<BillingResult> {
  const containerId = container.id;
  const containerName = container.name;
  const organizationId = container.organization_id;

  // Calculate daily cost for this container
  const dailyCost = calculateDailyContainerCost({
    desiredCount: container.desired_count,
    cpu: container.cpu,
    memory: container.memory,
  });

  const currentBalance = Number(org.credit_balance);
  // When pay-as-you-go is on (default), earnings absorb the bill before
  // credits. When off, earnings stay untouched and hosting comes purely
  // from credits — the org's owner controls this via /dashboard/billing.
  const earningsAvailable = org.pay_as_you_go_from_earnings ? org.earnings_available : 0;
  const totalAvailable = currentBalance + earningsAvailable;
  const now = new Date();

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

    await dbWrite
      .update(containers)
      .set({
        status: "stopped",
        billing_status: "suspended" as BillingStatus,
        updated_at: now,
      })
      .where(eq(containers.id, containerId));

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
    if (container.billing_status === "active" || !container.shutdown_warning_sent_at) {
      // Send 48-hour warning and schedule shutdown
      const shutdownTime = new Date(
        now.getTime() + CONTAINER_PRICING.SHUTDOWN_WARNING_HOURS * 60 * 60 * 1000,
      );

      await dbWrite
        .update(containers)
        .set({
          billing_status: "shutdown_pending" as BillingStatus,
          shutdown_warning_sent_at: now,
          scheduled_shutdown_at: shutdownTime,
          updated_at: now,
        })
        .where(eq(containers.id, containerId));

      // Send warning email
      const recipientEmail = org.billing_email || (await getOrgUserEmail(organizationId));
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
          billingUrl: `${appUrl}/dashboard/billing`,
          dashboardUrl: `${appUrl}/dashboard/containers/${containerId}`,
        });

        logger.info(
          `[Container Billing] Sent shutdown warning for ${containerName} to ${recipientEmail}`,
        );
      }

      // Record the billing failure
      await dbWrite.insert(containerBillingRecords).values({
        container_id: containerId,
        organization_id: organizationId,
        amount: String(dailyCost),
        billing_period_start: now,
        billing_period_end: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: "insufficient_credits",
        error_message: `Insufficient funds: required $${dailyCost.toFixed(2)}, available $${totalAvailable.toFixed(4)} (credits $${currentBalance.toFixed(4)} + earnings $${earningsAvailable.toFixed(4)})`,
        created_at: now,
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

  // Pay-as-you-go split: take what we can from earnings (sweeping the
  // smallest amount needed), then charge the remainder to org credits.
  // Earnings → org credits conversion goes through redeemableEarningsService
  // so we get a credit_conversion ledger entry for the audit trail.
  const fromEarnings = Math.min(earningsAvailable, dailyCost);
  const fromCredits = dailyCost - fromEarnings;

  if (fromEarnings > 0 && org.earnings_source_user_id) {
    const conversion = await redeemableEarningsService.convertToCredits({
      userId: org.earnings_source_user_id,
      amount: fromEarnings,
      organizationId,
      description: `Container hosting: ${containerName}`,
      metadata: {
        container_id: containerId,
        container_name: containerName,
        billing_type: "daily_container",
        billing_period: now.toISOString().split("T")[0],
      },
    });
    if (!conversion.success) {
      logger.error(`[Container Billing] Earnings convert failed for ${containerName}`, conversion);
      // Fall through: try to charge full cost to credits below.
    }
  }

  const newBalance = currentBalance + fromEarnings - dailyCost;

  // Atomic billing — credits down by (dailyCost - fromEarnings), record kept.
  const billingResult = await dbWrite.transaction(async (tx) => {
    await tx
      .update(organizations)
      .set({
        credit_balance: String(newBalance),
        updated_at: now,
      })
      .where(eq(organizations.id, organizationId));

    const [creditTx] = await tx
      .insert(creditTransactions)
      .values({
        organization_id: organizationId,
        user_id: container.user_id,
        amount: String(-dailyCost),
        type: "debit",
        description: `Daily container billing: ${containerName}`,
        metadata: {
          container_id: containerId,
          container_name: containerName,
          billing_type: "daily_container",
          billing_period: now.toISOString().split("T")[0],
          paid_from_earnings: fromEarnings.toFixed(4),
          paid_from_credits: fromCredits.toFixed(4),
        },
        created_at: now,
      })
      .returning();

    await tx
      .update(containers)
      .set({
        last_billed_at: now,
        next_billing_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        billing_status: "active" as BillingStatus,
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
        total_billed: String(Number(container.total_billed) + dailyCost),
        updated_at: now,
      })
      .where(eq(containers.id, containerId));

    await tx.insert(containerBillingRecords).values({
      container_id: containerId,
      organization_id: organizationId,
      amount: String(dailyCost),
      billing_period_start: now,
      billing_period_end: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "success",
      credit_transaction_id: creditTx.id,
      created_at: now,
    });

    return { newBalance, transactionId: creditTx.id };
  });

  logger.info(
    `[Container Billing] Billed ${containerName}: $${dailyCost.toFixed(4)} (earnings $${fromEarnings.toFixed(4)} + credits $${fromCredits.toFixed(4)})`,
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
    amount: dailyCost,
    paidFromEarnings: fromEarnings,
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
    const appUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

    logger.info("[Container Billing] Starting daily container billing run");
    // Get all running containers that need billing
    const runningContainers = await dbRead
      .select({
        id: containers.id,
        name: containers.name,
        project_name: containers.project_name,
        organization_id: containers.organization_id,
        user_id: containers.user_id,
        status: containers.status,
        billing_status: containers.billing_status,
        desired_count: containers.desired_count,
        cpu: containers.cpu,
        memory: containers.memory,
        shutdown_warning_sent_at: containers.shutdown_warning_sent_at,
        scheduled_shutdown_at: containers.scheduled_shutdown_at,
        total_billed: containers.total_billed,
      })
      .from(containers)
      .where(
        and(
          eq(containers.status, "running"),
          // Include active and shutdown_pending (to check if shutdown time reached)
          inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
        ),
      );

    if (runningContainers.length === 0) {
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

    logger.info(`[Container Billing] Processing ${runningContainers.length} containers`);

    // Get all unique organization IDs
    const orgIds = [...new Set(runningContainers.map((c) => c.organization_id))];

    // Fetch all organizations at once
    const orgs = await dbRead
      .select({
        id: organizations.id,
        name: organizations.name,
        credit_balance: organizations.credit_balance,
        pay_as_you_go_from_earnings: organizations.pay_as_you_go_from_earnings,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    // Get billing emails for these orgs
    const billingData = await dbRead
      .select({
        organization_id: organizationBilling.organization_id,
        billing_email: organizationBilling.billing_email,
      })
      .from(organizationBilling)
      .where(inArray(organizationBilling.organization_id, orgIds));

    const billingEmailMap = new Map(billingData.map((b) => [b.organization_id, b.billing_email]));

    // Resolve each org's earnings source user + their available balance once
    // so we don't query inside the per-container loop.
    const earningsByOrg = new Map<string, { sourceUserId: string | null; available: number }>();
    for (const orgId of orgIds) {
      const sourceUserId = await findEarningsSourceUserId(orgId);
      const available = sourceUserId ? await getAvailableEarnings(sourceUserId) : 0;
      earningsByOrg.set(orgId, { sourceUserId, available });
    }

    const orgMap = new Map(
      orgs.map((o) => {
        const earnings = earningsByOrg.get(o.id) ?? { sourceUserId: null, available: 0 };
        return [
          o.id,
          {
            ...o,
            billing_email: billingEmailMap.get(o.id) ?? null,
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
        const result = await processContainerBilling(container, org, appUrl);
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
        logger.error(`[Container Billing] Error processing container ${container.name}`, { error });
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
