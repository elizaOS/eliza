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

import { requireAdmin } from "@elizaos/cloud-shared/auth";
import { containersRepository } from "@elizaos/cloud-shared/db/repositories/containers";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { parsePositiveInteger } from "@elizaos/core/protocol";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.get("/", async (c) => {
  try {
    await requireAdmin(c);
    const limit = Math.min(
      parsePositiveInteger(c.req.query("limit"), 500),
      2000,
    );
    const rows = await containersRepository.listForAdminInfrastructure(limit);
    return c.json({ containers: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Infra Containers] list error", { error });
    return failureResponse(c, error);
  }
});
export default app;
