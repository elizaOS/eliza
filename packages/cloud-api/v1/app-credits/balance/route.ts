/**
 * GET /api/v1/app-credits/balance — user's credit balance for a specific app.
 *
 * Query: app_id (required, also accepted via X-App-Id header).
 *
 * CORS is handled globally (wildcard origin, no credentials).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appCreditsService } from "@/lib/services/app-credits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const LOW_BALANCE_THRESHOLD = 5;

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const appId = c.req.query("app_id") || c.req.header("X-App-Id");
    if (!appId) {
      return c.json({ success: false, error: "app_id is required" }, 400);
    }

    const user = await requireUserOrApiKeyWithOrg(c);

    let balance = await appCreditsService.getBalance(appId, user.id);

    if (!balance) {
      await appCreditsService.getOrCreateBalance(appId, user.id, user.organization_id);
      balance = await appCreditsService.getBalance(appId, user.id);
    }

    return c.json({
      success: true,
      balance: balance?.balance ?? 0,
      totalPurchased: balance?.totalPurchased ?? 0,
      totalSpent: balance?.totalSpent ?? 0,
      isLow: (balance?.balance ?? 0) < LOW_BALANCE_THRESHOLD,
    });
  } catch (error) {
    logger.error("[App Credits API] Failed to get balance:", error);
    return failureResponse(c, error);
  }
});

export default app;
