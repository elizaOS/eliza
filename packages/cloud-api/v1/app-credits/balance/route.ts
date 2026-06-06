/**
 * GET /api/v1/app-credits/balance — credits spendable in a specific app.
 *
 * Query: app_id (required, also accepted via X-App-Id header).
 *
 * App purchases fund and app inference debits the user's ORGANIZATION
 * credit balance — one ledger (#8253) — so this reports the org balance.
 * The app_id is still required so the route stays per-app addressable
 * (and so a future per-app view can be reintroduced without a contract
 * change).
 *
 * CORS is handled globally (wildcard origin, no credentials).
 */

import { organizationsRepository } from "@elizaos/cloud-shared/db/repositories/organizations";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
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
    const org = await organizationsRepository.findById(user.organization_id);
    const balance = org ? Number.parseFloat(String(org.credit_balance)) : 0;

    return c.json({
      success: true,
      balance,
      isLow: balance < LOW_BALANCE_THRESHOLD,
    });
  } catch (error) {
    logger.error("[App Credits API] Failed to get balance:", error);
    return failureResponse(c, error);
  }
});

export default app;
