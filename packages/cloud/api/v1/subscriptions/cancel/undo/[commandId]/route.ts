/** Reads an undo-cancellation command only for the currently authenticated organization billing manager. */
import { Hono } from "hono";
import { z } from "zod";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { readOrganizationSubscriptionCancellationUndo } from "@/lib/services/subscription-cancellation";
import type { AppEnv } from "@/types/cloud-worker-env";
import { cancellationFailure } from "../../_boundary";

const app = new Hono<AppEnv>();
app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireCurrentBillingManagerSession(c);
    const commandId = z.string().uuid().parse(c.req.param("commandId"));
    const data = await readOrganizationSubscriptionCancellationUndo({
      organizationId: user.organization_id,
      actorId: user.id,
      commandId,
    });
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 Polling errors remain sanitized and never expose provider state.
    return cancellationFailure(c, error);
  }
});
export default app;
