/**
 * GET /api/v1/containers/quota
 * Container quota + pricing for the authed user's org. Includes current
 * usage, deployment cost, daily burn, and credit runway.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  CONTAINER_LIMITS,
  CONTAINER_PRICING,
  calculateDailyContainerCost,
  calculateDeploymentCost,
  getMaxContainersForOrg,
} from "@/lib/constants/pricing";
import { listContainers } from "@/lib/services/containers";
import { organizationsService } from "@/lib/services/organizations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const org = await organizationsService.getById(user.organization_id);
    if (!org) return c.json({ success: false, error: "Organization not found" }, 404);

    const existingContainers = await listContainers(user.organization_id);
    const currentCount = existingContainers.length;

    const maxContainers = getMaxContainersForOrg(
      Number(org.credit_balance),
      org.settings as Record<string, unknown> | undefined,
    );

    const baseCost = calculateDeploymentCost({
      desiredCount: 1,
      cpu: 1792,
      memory: 1792,
    });

    const dailyRunningCost = calculateDailyContainerCost({
      desiredCount: 1,
      cpu: 1792,
      memory: 1792,
    });

    const runningContainers = existingContainers.filter((cn) => cn.status === "running");
    const currentDailyBurn = runningContainers.reduce(
      (total, container) =>
        total +
        calculateDailyContainerCost({
          desiredCount: container.desired_count,
          cpu: container.cpu,
          memory: container.memory,
        }),
      0,
    );

    const currentBalance = Number(org.credit_balance);
    const daysOfRunway =
      currentDailyBurn > 0 ? Math.floor(currentBalance / currentDailyBurn) : Infinity;

    return c.json({
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
          maxInstancesPerContainer: CONTAINER_LIMITS.MAX_INSTANCES_PER_CONTAINER,
          maxEnvVars: CONTAINER_LIMITS.MAX_ENV_VARS,
        },
      },
    });
  } catch (error) {
    logger.error("[Containers Quota API] error:", error);
    return failureResponse(c, error);
  }
});

export default app;
