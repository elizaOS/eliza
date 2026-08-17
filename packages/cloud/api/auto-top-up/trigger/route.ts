/**
 * Translates an authenticated organization's manual auto-top-up request
 * through the sealed cutover bridge. This boundary never reads or recomputes
 * money values and rejects requests when the shared limiter is unavailable.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { autoTopUpService } from "@/lib/services/auto-top-up";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use(
  "*",
  rateLimit({
    ...RateLimitPresets.STRICT,
    failClosed: true,
  }),
);

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const result = await autoTopUpService.executeAutoTopUpForOrganization(
      user.organization_id,
    );

    return c.json(
      {
        success: false,
        status: result.status,
        code: "service_unavailable" as const,
        error: result.error,
        message:
          "Auto top-up charging is temporarily paused during the durable cutover.",
      },
      503,
      { "Retry-After": "60" },
    );
  } catch (error) {
    // error-policy:J1 boundary translation — auth and cutover-control failures
    // remain explicit transport errors and can never fall through to charging.
    logger.error("[AutoTopUp] Manual cutover request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
