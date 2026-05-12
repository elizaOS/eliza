/**
 * GET /api/v1/admin/users
 *
 * Admin-only listing of users for the admin dashboard. Returns the minimum
 * surface the SPA needs to render the users table.
 *
 * Requires admin role.
 */

import { Hono } from "hono";
import { usersRepository } from "@/db/repositories/users";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 1000);

    const rows = await usersRepository.listForAdminDashboard(limit);

    return c.json({ users: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Users] list error", { error });
    return failureResponse(c, error);
  }
});

export default app;
