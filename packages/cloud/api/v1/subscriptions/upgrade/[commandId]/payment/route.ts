/** Returns a private original-invoice payment continuation after current authority checks. */
import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { continueOrganizationSubscriptionUpgradePayment } from "@elizaos/cloud-shared/lib/services/organization-upgrade-payment";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { upgradeFailure } from "../../_boundary";

const app = new Hono<AppEnv>();
app.post("/", moneyRateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const commandId = z.string().uuid().parse(c.req.param("commandId"));
    const data = await continueOrganizationSubscriptionUpgradePayment(
      { commandId, organizationId: user.organization_id, actorId: user.id },
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
    // error-policy:J1 authorization and command state never expose private provider details.
    return upgradeFailure(c, error);
  }
});
export default app;
