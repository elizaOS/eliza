/**
 * GET /api/v1/admin/cloud-observability
 *
 * Request and DB telemetry for local/backend operators. This endpoint is
 * intentionally read-only and backed by the current Worker/Node isolate ring
 * buffer; persisted analytics still live in usage/billing tables.
 */

import { requireAdmin } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  clearCloudTelemetry,
  getCloudTelemetrySnapshot,
} from "@elizaos/cloud-shared/lib/observability/cloud-backend-observability";
import { parseClampedLimit } from "@elizaos/cloud-shared/lib/utils/clamp-limit";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);
    return c.json({
      success: true,
      data: getCloudTelemetrySnapshot(
        parseClampedLimit(c.req.query("limit"), 200, 1_000),
      ),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const { role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json(
        { success: false, error: "Super admin access required" },
        403,
      );
    }
    clearCloudTelemetry();
    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
