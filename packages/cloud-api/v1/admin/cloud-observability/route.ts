/**
 * GET /api/v1/admin/cloud-observability
 *
 * Request and DB telemetry for local/backend operators. This endpoint is
 * intentionally read-only and backed by the current Worker/Node isolate ring
 * buffer; persisted analytics still live in usage/billing tables.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  clearCloudTelemetry,
  getCloudTelemetrySnapshot,
} from "@/lib/observability/cloud-backend-observability";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function parseLimit(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 200;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1_000) : 200;
}

app.get("/", async (c) => {
  try {
    await requireAdmin(c);
    return c.json({
      success: true,
      data: getCloudTelemetrySnapshot(parseLimit(c.req.query("limit"))),
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
