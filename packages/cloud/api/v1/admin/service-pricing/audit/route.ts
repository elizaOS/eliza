/**
 * GET /api/v1/admin/service-pricing/audit?service_id=...&limit=&offset=
 * Audit history for service pricing changes. Requires admin role.
 */

import { requireAdmin } from "@elizaos/cloud-shared/auth";
import { servicePricingRepository } from "@elizaos/cloud-shared/db/repositories";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  parseClampedLimit,
  parseClampedOffset,
} from "@elizaos/cloud-shared/lib/utils/clamp-limit";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const serviceId = c.req.query("service_id");
    if (!serviceId) {
      return c.json({ error: "service_id query parameter is required" }, 400);
    }

    const limit = parseClampedLimit(c.req.query("limit"), 50, 500);
    const offset = parseClampedOffset(c.req.query("offset"));

    const history = await servicePricingRepository.listAuditHistory(
      serviceId,
      limit,
      offset,
    );

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
