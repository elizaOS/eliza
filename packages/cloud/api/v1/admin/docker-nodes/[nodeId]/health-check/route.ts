// Handles admin cloud API v1 admin docker nodes nodeid health check route traffic with privileged auth expectations.

import { requireAdmin } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { forwardToContainerControlPlane } from "../../../../_container-control-plane-forward";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const { user, role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json(
        { success: false, error: "Super admin access required" },
        403,
      );
    }
    return forwardToContainerControlPlane(c, user);
  } catch (error) {
    logger.error("[Admin Docker Node Health Check] forward error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
