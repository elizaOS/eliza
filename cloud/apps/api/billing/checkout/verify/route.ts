/**
 * POST /api/billing/checkout/verify
 *
 * Synchronous fallback for the Stripe webhook on the billing-success page.
 * Retrieves a Stripe Checkout Session, verifies it belongs to the caller's
 * organization, and credits the org once (idempotent on payment_intent.id via
 * `creditsService.addCredits`). Returns the live balance and whether the
 * webhook had already applied the credits.
 */

import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { ForbiddenError, failureResponse, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { creditsService } from "@/lib/services/credits";
import { invoicesService } from "@/lib/services/invoices";
import { organizationsService } from "@/lib/services/organizations";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_CREDITS = 10000;

const VerifyBody = z.object({
  session_id: z.string().min(1),
  from: z.string().optional(),
});

function parseAndValidateCredits(creditsStr: string): number | null {
  const credits = Number.parseFloat(creditsStr);
  if (!Number.isFinite(credits) || credits <= 0 || credits > MAX_CREDITS) {
    return null;
  }
  return Math.round(credits * 100) / 100;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const rawBody = await c.req.json().catch(() => null);
    const parsed = VerifyBody.safeParse(rawBody);
    if (!parsed.success) {
      throw ValidationError("Invalid request body", {
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const { session_id: sessionId } = parsed.data;

    const session = await requireStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });

    if (session.payment_status !== "paid") {
      throw ValidationError(`Payment not completed. Status: ${session.payment_status}`);
    }

    const organizationId = session.metadata?.organization_id;
    const userId = session.metadata?.user_id;
    const creditsStr = session.metadata?.credits ?? "0";
    const credits = parseAndValidateCredits(creditsStr);
    const purchaseType = session.metadata?.type ?? "checkout";

    const paymentIntent = session.payment_intent as Stripe.PaymentIntent | string | null;
    const paymentIntentId =
      typeof paymentIntent === "string" ? paymentIntent : (paymentIntent?.id ?? null);

    if (organizationId !== user.organization_id || (userId && userId !== user.id)) {
      throw ForbiddenError("You do not have access to this checkout session.");
    }

    if (
      !organizationId ||
      !credits ||
      (purchaseType !== "custom_amount" && purchaseType !== "credit_pack")
    ) {
      throw ValidationError("Invalid session metadata");
    }

    if (!paymentIntentId) {
      throw ValidationError("No payment intent found on session");
    }

    const existingTransaction =
      await creditsService.getTransactionByStripePaymentIntent(paymentIntentId);

    if (existingTransaction) {
      const freshOrg = await organizationsService.getById(user.organization_id);
      const balance = Number(freshOrg?.credit_balance ?? 0);
      return c.json({
        success: true,
        balance,
        alreadyApplied: true,
      });
    }

    const { newBalance } = await creditsService.addCredits({
      organizationId,
      amount: credits,
      description: `Balance top-up - $${credits.toFixed(2)}`,
      metadata: {
        user_id: userId,
        payment_intent_id: paymentIntentId,
        session_id: sessionId,
        type: purchaseType,
        source: "success_page_fallback",
      },
      stripePaymentIntentId: paymentIntentId,
    });

    const existingInvoice = await invoicesService.getByStripeInvoiceId(`cs_${sessionId}`);
    if (!existingInvoice) {
      const amountTotal = session.amount_total
        ? (session.amount_total / 100).toString()
        : credits.toString();

      await invoicesService.create({
        organization_id: organizationId,
        stripe_invoice_id: `cs_${sessionId}`,
        stripe_customer_id: session.customer as string,
        stripe_payment_intent_id: paymentIntentId,
        amount_due: amountTotal,
        amount_paid: amountTotal,
        currency: session.currency ?? "usd",
        status: "paid",
        invoice_type: purchaseType,
        invoice_number: undefined,
        invoice_pdf: undefined,
        hosted_invoice_url: undefined,
        credits_added: credits.toString(),
        metadata: {
          type: purchaseType,
          session_id: sessionId,
          source: "success_page_fallback",
        },
        paid_at: new Date(),
      });
    }

    return c.json({
      success: true,
      balance: newBalance,
      alreadyApplied: false,
    });
  } catch (error) {
    logger.error("[Billing Checkout Verify] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
