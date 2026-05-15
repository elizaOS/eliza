/**
 * GET /api/v1/app-credits/verify — verify a completed Stripe checkout session
 * and confirm app credits were added.
 *
 * Idempotent: if the webhook already processed the purchase, returns success.
 *
 * CORS is handled globally (wildcard origin, no credentials).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appCreditsService } from "@/lib/services/app-credits";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

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
    if (metadata.type !== "app_credit_purchase") {
      return c.json({ success: false, error: "Invalid session type" });
    }

    const appId = metadata.app_id;
    const userId = metadata.user_id;
    const organizationId = metadata.organization_id;
    const amount = Number.parseFloat(metadata.amount || "0");

    if (!appId || !userId || !organizationId || !amount) {
      return c.json({ success: false, error: "Invalid session metadata" });
    }

    if (organizationId !== user.organization_id || userId !== user.id) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : null;
    if (!paymentIntentId) {
      return c.json({ success: false, error: "Missing payment intent" }, 400);
    }

    try {
      await appCreditsService.processPurchase({
        appId,
        userId,
        organizationId,
        purchaseAmount: amount,
        stripePaymentIntentId: paymentIntentId,
      });

      logger.info("[App Credits API] Verified and processed app credit purchase", {
        sessionId,
        appId,
        userId,
        amount,
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : "";
      if (!errorMsg.includes("already processed")) {
        throw e;
      }
      logger.info("[App Credits API] Purchase already processed", { sessionId });
    }

    return c.json({
      success: true,
      amount,
      message: "Credits added successfully",
    });
  } catch (error) {
    logger.error("[App Credits API] Failed to verify purchase:", error);
    return failureResponse(c, error);
  }
});

export default app;
