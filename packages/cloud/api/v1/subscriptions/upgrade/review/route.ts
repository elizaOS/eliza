/** Saves a provider-observed upgrade review without creating a subscription command. */
import type { OrganizationSubscriptionUpgradeQuoteDto } from "@elizaos/cloud-sdk/contracts";
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
import { createOrganizationUpgradeQuote } from "@elizaos/cloud-shared/lib/services/organization-upgrade-preview";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const schema = z
  .object({
    subscriptionId: z.string().uuid(),
    expectedSubscriptionRevision: z.number().int().positive().safe(),
    targetPlanKey: z.enum(["plus_monthly", "pro_monthly"]),
  })
  .strict();
const app = new Hono<AppEnv>();
app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // error-policy:J1 malformed client JSON is an explicit request error.
      throw new ApiError(
        400,
        "validation_error",
        "A JSON upgrade review request is required",
      );
    }
    const input = schema.parse(body);
    const quote = await createOrganizationUpgradeQuote(
      { ...input, organizationId: user.organization_id, actorId: user.id },
      async () => {
        const current = await requireCurrentBillingManagerSession(c);
        if (
          current.id !== user.id ||
          current.organization_id !== user.organization_id
        )
          throw ForbiddenError("Organization billing authority changed");
      },
    );
    const data: OrganizationSubscriptionUpgradeQuoteDto = {
      quoteId: quote.id,
      review: quote.review,
    };
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 provider and private persistence details never enter HTTP errors.
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN")
      return failureResponse(
        c,
        new ApiError(
          403,
          "access_denied",
          "Current organization billing manager required",
        ),
      );
    if (code === "SUBSCRIPTION_PLAN_CHANGE_CONFLICT")
      return failureResponse(
        c,
        new ApiError(
          409,
          "billing_state_conflict",
          "Subscription changed; review current billing state",
        ),
      );
    if (
      typeof code === "string" &&
      (code.startsWith("SUBSCRIPTION_PLAN_CHANGE_") ||
        code.startsWith("BILLING_PROVIDER_") ||
        code.startsWith("SUBSCRIPTION_CATALOG_") ||
        code === "SUBSCRIPTION_CANCELLATION_REOBSERVE")
    )
      return failureResponse(
        c,
        new ApiError(
          503,
          "service_unavailable",
          "A complete upgrade review is not available",
        ),
      );
    return failureResponse(c, error);
  }
});
export default app;
