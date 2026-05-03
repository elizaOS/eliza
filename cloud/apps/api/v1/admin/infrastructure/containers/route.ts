/**
 * GET /api/v1/admin/infrastructure/containers
 *
 * Admin-only flat listing of all Docker containers across the platform.
 * Used by the infrastructure dashboard. Live SSH inspection is handled by
 * the Node sidecar (see /api/v1/admin/infrastructure); this route only
 * reads the DB rows.
 *
 * Requires admin role.
 */

import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/helpers";
import { containers } from "@/db/schemas/containers";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const limit = Math.min(parseInt(c.req.query("limit") || "500", 10), 2000);

    const rows = await dbRead
      .select({
        id: containers.id,
        name: containers.name,
        project_name: containers.project_name,
        organization_id: containers.organization_id,
        user_id: containers.user_id,
        status: containers.status,
        public_hostname: containers.public_hostname,
        node_id: containers.node_id,
        cpu: containers.cpu,
        memory: containers.memory,
        desired_count: containers.desired_count,
        created_at: containers.created_at,
        updated_at: containers.updated_at,
      })
      .from(containers)
      .orderBy(desc(containers.created_at))
      .limit(limit);

    return c.json({ containers: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Infra Containers] list error", { error });
    return failureResponse(c, error);
  }
});

export default app;
