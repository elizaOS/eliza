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
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

export function parseContainerListLimit(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return 500;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 500;
  return Math.min(parsed, 2000);
}

app.get("/", async (c) => {
  try {
    await requireAdmin(c);

    const limit = parseContainerListLimit(c.req.query("limit"));

    const rows = await containersRepository.listForAdminInfrastructure(limit);

    return c.json({ containers: rows, total: rows.length });
  } catch (error) {
    logger.error("[Admin Infra Containers] list error", { error });
    return failureResponse(c, error);
  }
});

export default app;
