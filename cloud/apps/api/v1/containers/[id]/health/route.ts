/**
 * GET /api/v1/containers/[id]/health
 * Probe a container's health endpoint over HTTP. Workers-safe.
 */

import { Hono } from "hono";
import { containersRepository } from "@/db/repositories/containers";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getContainerHealthStatus } from "@/lib/services/health-monitor";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const containerId = c.req.param("id");
    if (!containerId) {
      return c.json({ success: false, error: "Container id required" }, 400);
    }

    const container = await containersRepository.findById(containerId, user.organization_id);
    if (!container) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }

    const healthStatus = await getContainerHealthStatus(containerId);
    if (!healthStatus) {
      return c.json(
        {
          success: false,
          error: "Unable to perform health check - container may not have a URL",
        },
        400,
      );
    }

    return c.json({
      success: true,
      data: {
        containerId: healthStatus.containerId,
        healthy: healthStatus.healthy,
        statusCode: healthStatus.statusCode,
        responseTime: healthStatus.responseTime,
        error: healthStatus.error,
        checkedAt: healthStatus.checkedAt,
        containerStatus: container.status,
        lastHealthCheck: container.last_health_check,
      },
    });
  } catch (error) {
    logger.error("[Containers API] health error:", error);
    return failureResponse(c, error);
  }
});

export default app;
