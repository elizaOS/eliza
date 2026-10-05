/**
 * GET|POST /api/cron/audit-log-purge (scheduled daily via CRON_FANOUT)
 * Reaps expired rows from secret_audit_log and auth_events (D-4 retention purge).
 * Protected by CRON_SECRET.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { purgeExpiredAuditLog } from "@elizaos/cloud-shared/lib/services/audit-log-purge";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const result = await purgeExpiredAuditLog();
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("[AuditLogPurgeCron] error purging audit log:", error);
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
