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

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { dbRead, dbWrite } from "@/db/client";
import { containers, containerBillingRecords } from "@/db/schemas/containers";
import { organizations } from "@/db/schemas/organizations";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { eq, and, inArray, lte, isNotNull, sql } from "drizzle-orm";
import {
  CONTAINER_PRICING,
  calculateDailyContainerCost,
} from "@/lib/constants/pricing";
import { emailService } from "@/lib/services/email";
import { usersRepository } from "@/db/repositories";
import { logger } from "@/lib/utils/logger";
import { trackServerEvent } from "@/lib/analytics/posthog-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes timeout

// Billing status types
type BillingStatus = "active" | "warning" | "suspended" | "shutdown_pending" | "archived";

interface BillingResult {
  containerId: string;
  containerName: string;
  organizationId: string;
  action: "billed" | "warning_sent" | "shutdown" | "skipped" | "error";
  amount?: number;
  newBalance?: number;
  error?: string;
}

interface BillingSummary {
  timestamp: Date;
  containersProcessed: number;
  containersBilled: number;
  warningsSent: number;
  containersShutdown: number;
  totalRevenue: number;
  errors: number;
  results: BillingResult[];
}

/**
 * Verify CRON secret using timing-safe comparison
 */
function verifyCronSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.error("[Container Billing] CRON_SECRET not configured");
    return false;
  }

  const providedSecret = authHeader?.replace("Bearer ", "") || "";
  const providedBuffer = Buffer.from(providedSecret, "utf8");
  const secretBuffer = Buffer.from(cronSecret, "utf8");

  return (
    providedBuffer.length === secretBuffer.length &&
    timingSafeEqual(providedBuffer, secretBuffer)
  );
}

/**
 * Process daily billing for a single container
 */
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
  },
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
  const now = new Date();

  logger.info(`[Container Billing] Processing ${containerName}`, {
    containerId,
    dailyCost,
    currentBalance,
    billingStatus: container.billing_status,
  });

  // Check if container is already scheduled for shutdown and time has passed
  if (
    container.billing_status === "shutdown_pending" &&
    container.scheduled_shutdown_at &&
    new Date(container.scheduled_shutdown_at) <= now
  ) {
    // Create a pre-eviction snapshot before shutting down so state can be restored
    await createPreEvictionSnapshot(containerId, containerName, organizationId);

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

    // Track shutdown event
    trackServerEvent(
      container.user_id,
      "container_shutdown_insufficient_credits",
      {
        container_id: containerId,
        container_name: containerName,
        organization_id: organizationId,
        balance_at_shutdown: currentBalance,
      },
    );

    return {
      containerId,
      containerName,
      organizationId,
      action: "shutdown",
    };
  }

  // Check if we have enough credits
  if (currentBalance < dailyCost) {
    // Insufficient credits - check if we need to send warning
    if (
      container.billing_status === "active" ||
      !container.shutdown_warning_sent_at
    ) {
      // Send 48-hour warning and schedule shutdown
      const shutdownTime = new Date(
        now.getTime() +
          CONTAINER_PRICING.SHUTDOWN_WARNING_HOURS * 60 * 60 * 1000,
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
      const recipientEmail =
        org.billing_email || (await getOrgUserEmail(organizationId));
      if (recipientEmail) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://eliza.cloud";
        await emailService.sendContainerShutdownWarningEmail({
          email: recipientEmail,
          organizationName: org.name,
          containerName: containerName,
          projectName: container.project_name,
          dailyCost,
          monthlyCost: CONTAINER_PRICING.MONTHLY_BASE_COST,
          currentBalance,
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
        error_message: `Insufficient credits: required $${dailyCost.toFixed(2)}, available $${currentBalance.toFixed(2)}`,
        created_at: now,
      });

      // Track warning event
      trackServerEvent(container.user_id, "container_shutdown_warning_sent", {
        container_id: containerId,
        container_name: containerName,
        organization_id: organizationId,
        daily_cost: dailyCost,
        current_balance: currentBalance,
        scheduled_shutdown: shutdownTime.toISOString(),
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

  // Has enough credits - process billing
  const newBalance = currentBalance - dailyCost;

  // Perform atomic billing transaction
  const billingResult = await dbWrite.transaction(async (tx) => {
    // Deduct credits
    await tx
      .update(organizations)
      .set({
        credit_balance: String(newBalance),
        updated_at: now,
      })
      .where(eq(organizations.id, organizationId));

    // Create credit transaction
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
        },
        created_at: now,
      })
      .returning();

    // Update container billing fields
    await tx
      .update(containers)
      .set({
        last_billed_at: now,
        next_billing_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        billing_status: "active" as BillingStatus,
        shutdown_warning_sent_at: null, // Clear any warning
        scheduled_shutdown_at: null,
        total_billed: String(Number(container.total_billed) + dailyCost),
        updated_at: now,
      })
      .where(eq(containers.id, containerId));

    // Record billing success
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
    `[Container Billing] Billed ${containerName}: $${dailyCost.toFixed(2)}`,
    {
      containerId,
      newBalance: billingResult.newBalance,
      transactionId: billingResult.transactionId,
    },
  );

  // Track billing event
  trackServerEvent(container.user_id, "container_daily_billed", {
    container_id: containerId,
    container_name: containerName,
    organization_id: organizationId,
    amount: dailyCost,
    new_balance: billingResult.newBalance,
  });

  return {
    containerId,
    containerName,
    organizationId,
    action: "billed",
    amount: dailyCost,
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
 * Create a pre-eviction snapshot before shutting down a container.
 * Non-fatal: if snapshot creation fails, the container is still shut down.
 */
async function createPreEvictionSnapshot(
  containerId: string,
  containerName: string,
  organizationId: string,
): Promise<void> {
  const { agentSnapshotService } = await import(
    "@/lib/services/agent-snapshots"
  );

  // Look up container URL for fetching state
  const containerRecord = await dbRead
    .select({ load_balancer_url: containers.load_balancer_url })
    .from(containers)
    .where(eq(containers.id, containerId))
    .limit(1);

  const containerUrl = containerRecord[0]?.load_balancer_url ?? null;

  logger.info(
    `[Container Billing] Creating pre-eviction snapshot for ${containerName}`,
    { containerId, hasUrl: !!containerUrl },
  );

  await agentSnapshotService.createSnapshot({
    containerId,
    organizationId,
    snapshotType: "pre-eviction",
    containerUrl,
    metadata: {
      trigger: "billing-eviction",
      containerName,
      evictedAt: new Date().toISOString(),
    },
  });

  logger.info(
    `[Container Billing] Pre-eviction snapshot saved for ${containerName}`,
  );
}

/**
 * Main billing handler
 */
async function handleContainerBilling(
  request: NextRequest,
): Promise<NextResponse> {
  const startTime = Date.now();

  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  logger.info("[Container Billing] Starting daily container billing run");

  try {
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
          inArray(containers.billing_status, [
            "active",
            "warning",
            "shutdown_pending",
          ]),
        ),
      );

    if (runningContainers.length === 0) {
      logger.info("[Container Billing] No running containers to bill");
      return NextResponse.json({
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

    // Fetch all organizations at once
    const orgs = await dbRead
      .select({
        id: organizations.id,
        name: organizations.name,
        credit_balance: organizations.credit_balance,
        billing_email: organizations.billing_email,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    const orgMap = new Map(orgs.map((o) => [o.id, o]));

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
        const result = await processContainerBilling(container, org);
        results.push(result);

        if (result.action === "billed" && result.amount) {
          totalRevenue += result.amount;
          containersBilled++;
          // Update org balance in memory for next container (same org)
          org.credit_balance = String(result.newBalance);
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

    return NextResponse.json({
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
        results: results.slice(0, 100), // Limit results in response
      },
    });
  } catch (error) {
    logger.error("[Container Billing] Failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Container billing failed",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/cron/container-billing
 * Daily container billing cron job.
 * Charges organizations for running containers and handles insufficient credit warnings.
 */
export async function GET(request: NextRequest) {
  return handleContainerBilling(request);
}

/**
 * POST /api/cron/container-billing
 * POST variant for manual triggering or external schedulers.
 */
export async function POST(request: NextRequest) {
  return handleContainerBilling(request);
}
