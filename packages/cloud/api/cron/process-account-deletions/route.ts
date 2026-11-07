/** Runs the scheduled deletion worker behind authenticated cron admission. */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { processDueAccountDeletions } from "@elizaos/cloud-shared/lib/services/account-deletion";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const result = await processDueAccountDeletions(10, { blob: c.env.BLOB });
    return c.json({ success: result.actionRequired === 0, ...result });
  } catch (error) {
    // error-policy:J1 The cron transport boundary logs and translates worker failure.
    logger.error("[AccountDeletionCron] Processing failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
