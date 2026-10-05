/**
 * GET /api/credits/balance
 * Gets the credit balance for the authenticated user's organization.
 * Supports both session and API key authentication.
 *
 * Query: `fresh=true` bypasses cache and reads from DB (kept for parity —
 * the Workers shim doesn't have the Next session cache so every read is fresh).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { getCreditBalanceResponse } from "@elizaos/cloud-shared/lib/services/credit-balance-response";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const user = await requireUserOrApiKeyWithOrg(c);
  const body = await getCreditBalanceResponse(user.organization_id);

  return c.json(body, 200, {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
});

export default app;
