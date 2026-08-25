/**
 * GET /api/v1/credits/verify?session_id=...
 * Verify a completed Stripe checkout session belongs to this org/user.
 */

import { Hono } from "hono";
import type Stripe from "stripe";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  StripeCheckoutAuthorityError,
  stripeCheckoutOrdersService,
} from "@/lib/services/stripe-checkout-orders";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.query("session_id");
    if (!sessionId) {
      return c.json({ success: false, error: "session_id is required" }, 400);
    }

    const session = await requireStripe().checkout.sessions.retrieve(
      sessionId,
      {
        expand: ["payment_intent"],
      },
    );
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
    const paymentIntent = session.payment_intent as
      | Stripe.PaymentIntent
      | string
      | null;
    const paymentIntentId =
      typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
    if (!paymentIntentId) {
      return c.json({ success: false, error: "No payment intent found" }, 400);
    }
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null);
    const orderId = metadata.checkout_order_id;
    const settlement = orderId
      ? await stripeCheckoutOrdersService.settle(
          {
            checkoutOrderId: orderId,
            clientReferenceId: session.client_reference_id,
            metadataOrderId: metadata.checkout_order_id ?? null,
            checkoutSessionId: session.id,
            paymentIntentId,
            paymentStatus: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
            customerId,
          },
          {
            callerOrganizationId: user.organization_id,
            callerUserId: user.id,
          },
        )
      : await stripeCheckoutOrdersService.settleLegacy(
          {
            checkoutSessionId: session.id,
            paymentIntentId,
            paymentStatus: session.payment_status,
            amountTotal: session.amount_total,
            currency: session.currency,
            customerId,
            organizationId: metadata.organization_id ?? null,
            initiatedByUserId: metadata.user_id ?? null,
            purchaseType: metadata.type ?? null,
            creditPackId: metadata.credit_pack_id ?? null,
            claimedCredits: metadata.credits ?? null,
          },
          {
            callerOrganizationId: user.organization_id,
            callerUserId: user.id,
          },
        );
    const creditsToGrant =
      "order" in settlement
        ? settlement.order.credits_to_grant
        : settlement.creditsToGrant;
    const amount = Number(creditsToGrant);
    logger.info("Verified credits checkout session", {
      sessionId,
      organizationId: metadata.organization_id,
      amount,
    });

    return c.json({
      success: true,
      amount,
      message: "Payment verified successfully",
    });
  } catch (error) {
    logger.error("[Credits Verify API v1] Error:", error);
    if (error instanceof StripeCheckoutAuthorityError) {
      const forbidden =
        error.code === "STRIPE_CHECKOUT_ORGANIZATION_MISMATCH" ||
        error.code === "STRIPE_CHECKOUT_USER_MISMATCH";
      return c.json(
        {
          success: false,
          error: forbidden ? "Forbidden" : "Checkout could not be verified",
        },
        forbidden ? 403 : 400,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
