/**
 * GET /api/cron/cleanup-expired-app-auth-codes
 *
 * Deletes expired rows from `app_auth_codes`. Active codes are 5 minutes by
 * design, so this is a low-volume housekeeping cron; running every 10 minutes
 * keeps the table small without competing with the much hotter
 * `cleanup-expired-crypto-payments` schedule. Wired into the every-10-minute
 * fanout in `packages/lib/cron/cloudflare-cron.ts`.
 */

import { Hono } from "hono";
import { appAuthCodesRepository } from "@/db/repositories/app-auth-codes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    requireCronSecret(c);

    const deleted = await appAuthCodesRepository.deleteExpired();
    logger.info("[App Auth Codes Cleanup] Pruned expired rows", { deleted });

    return c.json({ success: true, deleted });
  } catch (error) {
    logger.error("[App Auth Codes Cleanup] Failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
