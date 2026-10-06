/**
 * GET /api/v1/admin/orgs
 *
 * Admin-only listing of organizations for the admin dashboard. Returns the
 * minimum surface the SPA needs to render the orgs table.
 *
 * Requires admin role.
 */

import { requireAdmin } from "@elizaos/cloud-shared/auth";
import { organizationsRepository } from "@elizaos/cloud-shared/db/repositories/organizations";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { parseClampedLimit } from "@elizaos/cloud-shared/lib/utils/clamp-limit";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const limit = parseClampedLimit(c.req.query("limit"), 200, 1000);

    const rows = await organizationsRepository.listForAdminDashboard(limit);

    return c.json({ orgs: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Orgs] list error", { error });
    return failureResponse(c, error);
  }
});

export default app;
