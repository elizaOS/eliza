/** Opens the locked Stripe Customer Portal for the current organization billing manager's own subscription customer. */

import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  ForbiddenError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createSubscriptionPortalSession } from "@elizaos/cloud-shared/lib/services/subscription-customer-portal";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

function portalFailure(c: AppContext, error: unknown): Response {
  const code = error instanceof Error && "code" in error ? error.code : null;
  if (code === "SUBSCRIPTION_PORTAL_NOT_APPLICABLE")
    return failureResponse(
      c,
      new ApiError(
        409,
        "billing_state_conflict",
        "This account has no subscription billing to manage.",
      ),
    );
  if (code === "SUBSCRIPTION_PORTAL_UNAVAILABLE")
    return failureResponse(
      c,
      new ApiError(
        503,
        "service_unavailable",
        "Billing management is temporarily unavailable. Please retry.",
      ),
    );
  return failureResponse(c, error);
}

const app = new Hono<AppEnv>();
app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const data = await createSubscriptionPortalSession(
      { organizationId: user.organization_id },
      async () => {
        const current = await requireCurrentBillingManagerSession(c);
        if (
          current.id !== user.id ||
          current.organization_id !== user.organization_id
        )
          throw ForbiddenError("Organization billing authority changed");
      },
    );
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 Sanitize provider and authority failures at the HTTP boundary.
    return portalFailure(c, error);
  }
});
export default app;
