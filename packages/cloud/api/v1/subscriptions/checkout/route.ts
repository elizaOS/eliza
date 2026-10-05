/** Starts a recurring checkout for a freshly authorized organization billing manager. */

import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { submitSubscriptionCheckout } from "@elizaos/cloud-shared/lib/services/subscription-checkout";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { checkoutFailure } from "./_boundary";

const schema = z
  .object({
    planKey: z.enum(["plus_monthly", "pro_monthly"]),
    idempotencyKey: z.string().uuid(),
    /** hosted (default) redirects this browser; embedded mounts an in-app form; shared is a link for another payer. */
    presentation: z.enum(["hosted", "embedded", "shared"]).optional(),
  })
  .strict();
const app = new Hono<AppEnv>();
app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok)
      return c.json(
        {
          success: false,
          error: "Invalid JSON body",
          code: "validation_error",
        },
        400,
      );
    const input = schema.parse(decoded.value);
    const data = await submitSubscriptionCheckout(
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
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 Sanitize provider and authority failures at the HTTP boundary.
    return checkoutFailure(c, error);
  }
});
export default app;
