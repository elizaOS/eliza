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

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { organizationsRepository } from "@elizaos/cloud-shared/db/repositories/organizations";
import { parseOrganizationCreditBalance } from "@elizaos/cloud-shared/db/repositories/organizations-credit-balance-numeric";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
    // `credit_balance` is a Postgres NUMERIC (string at the row boundary). A
    // bare parseFloat fails open on a corrupt read: "100abc" truncated to 100
    // and "NaN" became a null balance with isLow: false. Fail closed with a
    // 500 like the mutation paths, instead of reporting a success-shaped,
    // wrong balance.
    const balance = org
      ? parseOrganizationCreditBalance(org.credit_balance, "credit_balance")
      : 0;

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
