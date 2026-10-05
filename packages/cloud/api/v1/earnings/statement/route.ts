/**
 * GET /api/v1/earnings/statement — read-only creator earnings statement.
 *
 * Creator monetization is retired (#22961 / #23022). This returns the balance
 * frozen for the caller at retirement (if any) plus the current ledger
 * balance. It never moves money; frozen balances are settled manually.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { creatorMonetizationRetirementService } from "@elizaos/cloud-shared/lib/services/creator-monetization-retirement";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const statement = await creatorMonetizationRetirementService.getStatement(
      user.id,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, statement });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
