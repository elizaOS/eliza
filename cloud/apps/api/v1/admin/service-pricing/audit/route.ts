/**
 * GET /api/v1/admin/service-pricing/audit?service_id=...&limit=&offset=
 * Audit history for service pricing changes. Requires admin role.
 */

import { Hono } from "hono";
import { servicePricingRepository } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const serviceId = c.req.query("service_id");
    if (!serviceId) {
      return c.json({ error: "service_id query parameter is required" }, 400);
    }

    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : 50;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 50;

    const rawOffset = c.req.query("offset");
    const parsedOffset = rawOffset ? parseInt(rawOffset, 10) : 0;
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

    const history = await servicePricingRepository.listAuditHistory(serviceId, limit, offset);

    return c.json({
      service_id: serviceId,
      limit,
      offset,
      history: history.map((h) => ({
        id: h.id,
        service_pricing_id: h.service_pricing_id,
        method: h.method,
        old_cost: h.old_cost,
        new_cost: h.new_cost,
        change_type: h.change_type,
        reason: h.reason,
        changed_by: h.changed_by,
        updated_by: h.changed_by,
        ip_address: h.ip_address,
        user_agent: h.user_agent,
        created_at: h.created_at,
      })),
    });
  } catch (error) {
    logger.error("[Admin] Service pricing audit error", { error });
    return failureResponse(c, error);
  }
});

export default app;
