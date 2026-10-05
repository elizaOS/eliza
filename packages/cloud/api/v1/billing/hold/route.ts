/**
 * Organization billing hold after an underfunding payment reversal (#22930).
 *
 * GET returns the typed hold state and its pay action. POST is the pay action
 * for funds already in the balance: a billing manager applies the current
 * balance to the outstanding shortfall, which clears the hold once covered.
 * Card top-ups apply the same settlement automatically when they land.
 */

import {
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { billingHoldService } from "@elizaos/cloud-shared/lib/services/billing-hold";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const hold = await billingHoldService.getState(user.organization_id);
    return c.json({ success: true, data: hold });
  } catch (error) {
    // error-policy:J1 the HTTP boundary records the failure and translates it.
    logger.error("[Billing Hold API] Failed to read billing hold", error);
    return failureResponse(c, error);
  }
});

app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const settlement = await billingHoldService.settleOutstandingShortfalls(
      user.organization_id,
    );
    const hold = await billingHoldService.getState(user.organization_id);
    return c.json({
      success: true,
      data: { appliedUsd: settlement.appliedUsd, hold },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary records the failure and translates it.
    logger.error(
      "[Billing Hold API] Failed to apply balance to billing hold",
      error,
    );
    return failureResponse(c, error);
  }
});

export default app;
