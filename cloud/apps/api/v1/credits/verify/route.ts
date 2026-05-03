/**
 * GET /api/v1/credits/verify?session_id=...
 * Verify a completed Stripe checkout session belongs to this org/user.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.query("session_id");
    if (!sessionId) {
      return c.json({ success: false, error: "session_id is required" }, 400);
    }

    const session = await requireStripe().checkout.sessions.retrieve(sessionId);
    if (!session) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    if (session.payment_status !== "paid") {
      return c.json({
        success: false,
        error: "Payment not completed",
        status: session.payment_status,
      });
    }

    const metadata = session.metadata || {};
    if (metadata.type !== "custom_amount" && metadata.type !== "credit_pack") {
      return c.json({ success: false, error: "Invalid session type" });
    }

    if (
      metadata.organization_id !== user.organization_id ||
      (metadata.user_id && metadata.user_id !== user.id)
    ) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const amount = parseFloat(metadata.credits || "0");
    logger.info("Verified credits checkout session", {
      sessionId,
      organizationId: metadata.organization_id,
      amount,
    });

    return c.json({ success: true, amount, message: "Payment verified successfully" });
  } catch (error) {
    logger.error("[Credits Verify API v1] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
