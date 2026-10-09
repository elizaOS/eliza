/** Confirms reviewed renewal terms under durable manager intent and a fresh dispatch fence. */

import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { submitReviewedOrganizationSubscriptionCancellationUndo } from "@elizaos/cloud-shared/lib/services/subscription-cancellation";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { cancellationFailure } from "../../_boundary";

const requestSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    expectedSubscriptionRevision: z.number().int().positive().safe(),
    expectedRenewalTermsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
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
    const data = await submitReviewedOrganizationSubscriptionCancellationUndo(
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
