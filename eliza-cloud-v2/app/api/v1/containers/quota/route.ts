import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { listContainers } from "@/lib/services/containers";
import {
  CONTAINER_PRICING,
  CONTAINER_LIMITS,
  getMaxContainersForOrg,
  calculateDeploymentCost,
  calculateDailyContainerCost,
} from "@/lib/constants/pricing";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/containers/quota
 * Retrieves container quota and pricing information for the authenticated user's organization.
 * Includes current usage, limits, and cost breakdowns.
 *
 * @param request - The Next.js request object.
 * @returns Quota information, credit balance, pricing details, and limits.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    // Get current container count
    const existingContainers = await listContainers(user.organization_id!);
    const currentCount = existingContainers.length;

    // Get max allowed containers
    const maxContainers = getMaxContainersForOrg(
      Number(user.organization.credit_balance),
      user.organization.settings as Record<string, unknown> | undefined,
    );

    // Calculate costs (base container: 1 instance, default CPU/memory)
    const baseCost = calculateDeploymentCost({
      desiredCount: 1,
      cpu: 1792, // Default: 1.75 vCPU (87.5% of t3g.small)
      memory: 1792, // Default: 1.75 GB (87.5% of t3g.small)
    });

    // Calculate daily running cost
    const dailyRunningCost = calculateDailyContainerCost({
      desiredCount: 1,
      cpu: 1792,
      memory: 1792,
    });

    // Calculate current daily costs for all running containers
    const runningContainers = existingContainers.filter(
      (c) => c.status === "running",
    );
    const currentDailyBurn = runningContainers.reduce((total, container) => {
      return (
        total +
        calculateDailyContainerCost({
          desiredCount: container.desired_count,
          cpu: container.cpu,
          memory: container.memory,
        })
      );
    }, 0);

    // Calculate days of runway
    const currentBalance = Number(user.organization.credit_balance);
    const daysOfRunway =
      currentDailyBurn > 0
        ? Math.floor(currentBalance / currentDailyBurn)
        : Infinity;

    return NextResponse.json({
      success: true,
      data: {
        quota: {
          current: currentCount,
          max: maxContainers,
          remaining: Math.max(0, maxContainers - currentCount),
          percentage: (currentCount / maxContainers) * 100,
        },
        credits: {
          balance: currentBalance,
          canDeploy: currentBalance >= baseCost,
        },
        billing: {
          // Daily billing information
          model: "daily",
          dailyCostPerContainer: dailyRunningCost,
          monthlyEquivalent: CONTAINER_PRICING.MONTHLY_BASE_COST,
          currentDailyBurn: Math.round(currentDailyBurn * 100) / 100,
          runningContainers: runningContainers.length,
          daysOfRunway: daysOfRunway === Infinity ? null : daysOfRunway,
          warningThreshold: CONTAINER_PRICING.LOW_CREDITS_WARNING_THRESHOLD,
          shutdownWarningHours: CONTAINER_PRICING.SHUTDOWN_WARNING_HOURS,
        },
        pricing: {
          imageUpload: CONTAINER_PRICING.IMAGE_UPLOAD,
          deployment: baseCost,
          totalForNewContainer: baseCost + CONTAINER_PRICING.IMAGE_UPLOAD,
          perDay: dailyRunningCost,
          perMonth: CONTAINER_PRICING.MONTHLY_BASE_COST,
          perAdditionalInstance: CONTAINER_PRICING.COST_PER_ADDITIONAL_INSTANCE,
        },
        limits: {
          maxImageSize: CONTAINER_LIMITS.MAX_IMAGE_SIZE_BYTES,
          maxInstancesPerContainer:
            CONTAINER_LIMITS.MAX_INSTANCES_PER_CONTAINER,
          maxEnvVars: CONTAINER_LIMITS.MAX_ENV_VARS,
        },
      },
    });
  } catch (error) {
    logger.error("Error fetching quota:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch quota",
      },
      { status: 500 },
    );
  }
}
