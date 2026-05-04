import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToContainerControlPlane } from "../../../../_container-control-plane-forward";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const { user, role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json({ success: false, error: "Super admin access required" }, 403);
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
