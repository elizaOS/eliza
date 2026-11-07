/** Reads durable primary command status without provider work. */
import { requireCurrentBillingManagerSession } from "@elizaos/cloud-shared/auth";
import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { readOrganizationSubscriptionDowngrade } from "@elizaos/cloud-shared/lib/services/organization-downgrade-command";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { downgradeFailure } from "../_boundary";

const app = new Hono<AppEnv>();
app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const commandId = z.string().uuid().parse(c.req.param("commandId"));
    const data = await readOrganizationSubscriptionDowngrade(
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
    return downgradeFailure(c, error);
  }
});
export default app;
