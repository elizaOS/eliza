/**
 * POST /api/cron/website-reputation-refresh
 *
 * Refreshes the website reputation index from the fixed public threat lists
 * (HaGeZi TIF medium and Fake, Phishing.Database) into R2. A failed list keeps
 * its last-good data; a failed run keeps the previous snapshot. Protected by
 * CRON_SECRET. See the website-reputation services.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { refreshWebsiteReputationIndex } from "@elizaos/cloud-shared/lib/services/website-reputation-ingest";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  const startedAt = Date.now();
  try {
    requireCronSecret(c);
    const summary = await refreshWebsiteReputationIndex();
    logger.info("[website-reputation-cron] completed", {
      durationMs: Date.now() - startedAt,
      snapshotId: summary.snapshotId,
      rebuilt: summary.rebuilt,
      recordCount: summary.recordCount,
      lists: summary.lists.map((list) => `${list.id}:${list.state}`).join(","),
    });
    return c.json({ success: true, summary });
  } catch (error) {
    logger.error("[website-reputation-cron] failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
