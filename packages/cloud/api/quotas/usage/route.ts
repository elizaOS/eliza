/**
 * GET /api/quotas/usage
 *
 * Authenticated tombstone for the retired weekly usage-quota subsystem. Keep
 * this route mounted through the database drain window so existing clients get
 * an explicit permanent-removal response without touching the retired table.
 */

import { Hono } from "hono";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    return c.json(
      {
        success: false,
        error: "Weekly usage quotas have been retired",
        code: "usage_quotas_retired",
      },
      410,
    );
  } catch (error) {
    // error-policy:J1 authentication failures are translated at the HTTP boundary.
    // Auth helpers already classify expected 4xx/503 outcomes. Preserve those
    // responses without noisy logs, but retain an observable, value-free signal
    // for an unexpected failure that would otherwise be swallowed here.
    if (!(error instanceof ApiError)) {
      logger.error("[Quota Usage] Tombstone authentication failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    return failureResponse(c, error);
  }
});

export default app;
