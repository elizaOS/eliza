/** Admits period-end cancellation for the current organization manager and revalidates the same session before provider work. */
import { Hono } from "hono";
import { z } from "zod";
import { ForbiddenError } from "@/lib/api/cloud-worker-errors";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { submitOrganizationSubscriptionCancellation } from "@/lib/services/subscription-cancellation";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";
import { cancellationFailure } from "./_boundary";

const requestSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    expectedSubscriptionRevision: z.number().int().positive().safe(),
    idempotencyKey: z.string().min(1).max(200).regex(/\S/),
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
          code: "validation_error",
          error: "Invalid JSON body",
        },
        400,
      );
    const input = requestSchema.parse(decoded.value);
    const data = await submitOrganizationSubscriptionCancellation(
      {
        ...input,
        organizationId: user.organization_id,
        actorId: user.id,
      },
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
    // error-policy:J1 The HTTP boundary exposes only sanitized command errors.
    return cancellationFailure(c, error);
  }
});
export default app;
