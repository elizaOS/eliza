/** Confirms only a server-owned original quote, never caller-supplied provider terms. */
import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  ForbiddenError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { confirmOrganizationSubscriptionUpgrade } from "@elizaos/cloud-shared/lib/services/organization-upgrade-command";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { upgradeFailure } from "../_boundary";

const schema = z
  .object({
    quoteId: z.string().uuid(),
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
      throw new ApiError(400, "validation_error", "Invalid JSON body");
    const input = schema.parse(decoded.value);
    const data = await confirmOrganizationSubscriptionUpgrade(
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
    // error-policy:J1 return sanitized command outcomes, never provider or persistence details.
    return upgradeFailure(c, error);
  }
});
export default app;
