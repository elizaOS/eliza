import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Admin: container pool capacity report + autoscaler decision.
 *
 * Read-only. Useful for dashboards and operator visibility — calling
 * this never mutates state. The same `evaluateCapacity()` logic runs
 * in the autoscale cron, so the dashboard can show exactly what the
 * autoscaler would decide on the next tick.
 */

import { requireAdmin } from "@/lib/auth";
import { isHetznerCloudConfigured } from "@/lib/services/containers/hetzner-cloud-api";
import { getNodeAutoscaler } from "@/lib/services/containers/node-autoscaler";
import { logger } from "@/lib/utils/logger";

async function __hono_GET(request: Request) {
  const { role } = await requireAdmin(request);
  if (role !== "super_admin") {
    return Response.json({ success: false, error: "Super admin access required" }, { status: 403 });
  }

  try {
    const decision = await getNodeAutoscaler().evaluateCapacity();
    return Response.json({
      success: true,
      data: {
        ...decision,
        elasticProvisioningConfigured: isHetznerCloudConfigured(),
      },
    });
  } catch (error) {
    logger.error("[admin/docker-nodes/capacity] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to read capacity",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;
