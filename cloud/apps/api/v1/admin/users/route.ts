/**
 * GET /api/v1/admin/users
 *
 * Admin-only listing of users for the admin dashboard. Returns the minimum
 * surface the SPA needs to render the users table.
 *
 * Requires admin role.
 */

import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/helpers";
import { users } from "@/db/schemas/users";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 1000);

    const rows = await dbRead
      .select({
        id: users.id,
        email: users.email,
        email_verified: users.email_verified,
        wallet_address: users.wallet_address,
        wallet_chain_type: users.wallet_chain_type,
        name: users.name,
        avatar: users.avatar,
        organization_id: users.organization_id,
        role: users.role,
        is_active: users.is_active,
        is_anonymous: users.is_anonymous,
        created_at: users.created_at,
        updated_at: users.updated_at,
      })
      .from(users)
      .orderBy(desc(users.created_at))
      .limit(limit);

    return c.json({ users: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Users] list error", { error });
    return failureResponse(c, error);
  }
});

export default app;
