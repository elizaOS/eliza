/**
 * GET /api/v1/admin/orgs
 *
 * Admin-only listing of organizations for the admin dashboard. Returns the
 * minimum surface the SPA needs to render the orgs table.
 *
 * Requires admin role.
 */

import { Hono } from "hono";
import { organizationsRepository } from "@/db/repositories/organizations";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 1000);

    const rows = await organizationsRepository.listForAdminDashboard(limit);

    return c.json({ orgs: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Orgs] list error", { error });
    return failureResponse(c, error);
  }
});

export default app;
