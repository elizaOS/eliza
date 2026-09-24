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
import { Hono } from "hono";
import { containersRepository } from "@/db/repositories/containers";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import { parsePositiveInteger } from "@elizaos/core/utils/number-parsing";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { type AppEnv } from "@/types/cloud-worker-env";
const app = new Hono<AppEnv>();
app.get("/", async (c) => {
    try {
        await requireAdmin(c);
        const limit = Math.min(parsePositiveInteger(c.req.query("limit"), 500), 2000);
        const rows = await containersRepository.listForAdminInfrastructure(limit);
        return c.json({ containers: rows, total: rows.length });
    }
    catch (error) {
        logger.error("[Admin Infra Containers] list error", { error });
        return failureResponse(c, error);
    }
});
export default app;
