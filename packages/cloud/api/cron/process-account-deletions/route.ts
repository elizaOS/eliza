import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { processDueAccountDeletions } from "@/lib/services/account-deletion";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const result = await processDueAccountDeletions(10, { blob: c.env.BLOB });
    return c.json({ success: result.actionRequired === 0, ...result });
  } catch (error) {
    logger.error("[AccountDeletionCron] Processing failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
