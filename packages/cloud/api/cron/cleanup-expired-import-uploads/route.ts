/**
 * GET /api/cron/cleanup-expired-import-uploads
 * Retention sweep for conversation imports (#13432): purges expired
 * short-lived raw uploads and aborts expired in-flight resumable sessions,
 * releasing tenant storage quota. Protected by CRON_SECRET.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);
    logger.info("[ConversationImports] Starting expired import upload cleanup");
    const report = await conversationImportsService.purgeExpired(c.env);
    return c.json({
      success: true,
      stats: {
        purgedArtifacts: report.purgedArtifacts,
        abortedSessions: report.abortedSessions,
        failures: report.failures,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("[ConversationImports] Cleanup job failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
