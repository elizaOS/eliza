/**
 * GET /api/cron/audit-log-purge
 * Reaps expired rows from secret_audit_log (D-4 retention purge).
 * Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { purgeExpiredAuditLog } from "@elizaos/cloud-shared/lib/services/audit-log-purge";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);
    const result = await purgeExpiredAuditLog();
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("[AuditLogPurgeCron] error purging audit log:", error);
    return failureResponse(c, error);
  }
});

export default app;
