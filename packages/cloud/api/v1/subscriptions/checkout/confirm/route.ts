/** Reconciles the signed-in account's checkout return using provider payment evidence, never redirect parameters as payment authority. */
import { Hono } from "hono";
import { z } from "zod";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { reconcileSubscriptionCheckout } from "@/lib/services/subscription-checkout";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";
import { checkoutFailure } from "../_boundary";

const schema = z
  .object({ sessionId: z.string().regex(/^cs_(test|live)_[A-Za-z0-9]+$/) })
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
    const { sessionId } = schema.parse(decoded.value);
    const data = await reconcileSubscriptionCheckout(
      sessionId,
      user.organization_id,
    );
    return c.json({ success: true as const, data });
  } catch (error) {
    // error-policy:J1 Return sanitized failures without exposing provider objects.
    return checkoutFailure(c, error);
  }
});
export default app;
