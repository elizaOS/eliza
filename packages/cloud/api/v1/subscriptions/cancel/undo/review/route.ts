/** Reads current renewal estimates without admitting or dispatching an undo command. */

import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { readOrganizationSubscriptionRenewalReview } from "@elizaos/cloud-shared/lib/services/subscription-renewal-review";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { cancellationFailure } from "../../_boundary";

const querySchema = z
  .object({
    subscriptionId: z.string().uuid(),
    expectedSubscriptionRevision: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive().safe()),
  })
  .strict();
const app = new Hono<AppEnv>();
app.get("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const input = querySchema.parse(c.req.query());
    const data = await readOrganizationSubscriptionRenewalReview(
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
    // error-policy:J1 expose sanitized domain errors without provider details.
    return cancellationFailure(c, error);
  }
});
export default app;
