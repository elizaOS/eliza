import { type NextRequest, NextResponse } from "next/server";
import { isStripeConfigured, requireStripe } from "@/lib/stripe";
import { creditsService } from "@/lib/services/credits";
import { invoicesService } from "@/lib/services/invoices";
import { appCreditsService } from "@/lib/services/app-credits";
import { referralsService } from "@/lib/services/referrals";
import { discordService } from "@/lib/services/discord";
import { referralSignupsRepository } from "@/db/repositories/referrals";
import { usersRepository } from "@/db/repositories/users";
import { organizationsRepository } from "@/db/repositories/organizations";
import { headers } from "next/headers";
import type Stripe from "stripe";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { trackServerEvent } from "@/lib/analytics/posthog-server";

// Maximum allowed credit amount for validation
const MAX_CREDITS = 10000;

/**
 * Type guard to check if a value is an expanded Stripe.Invoice
 */
function isInvoiceExpanded(invoice: unknown): invoice is Stripe.Invoice {
  return typeof invoice === "object" && invoice !== null && "id" in invoice;
}

/**
 * Safely parse and validate a credit amount from string
 * Returns null if the amount is invalid, not finite, or outside safe bounds
 */
function parseAndValidateCredits(creditsStr: string): number | null {
  const credits = Number.parseFloat(creditsStr);
  if (!Number.isFinite(credits) || credits <= 0 || credits > MAX_CREDITS) {
    return null;
  }
  // Round to 2 decimal places for currency safety
  return Math.round(credits * 100) / 100;
}

/**
 * POST /api/stripe/webhook
 * Stripe webhook endpoint for processing payment events.
 * Handles checkout sessions, payment intents, invoices, and subscription events.
 * Verifies webhook signatures for security.
 *
 * Rate limited: AGGRESSIVE (100 req/min per IP) to prevent webhook flooding
 *
 * @param req - Request containing Stripe webhook event data.
 * @returns Webhook processing result.
 */
async function handleStripeWebhook(req: NextRequest) {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "No signature provided" },
      { status: 400 },
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("[Stripe Webhook] STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json(
      { error: "Webhook configuration error" },
      { status: 500 },
    );
  }

  if (!isStripeConfigured()) {
    logger.error("[Stripe Webhook] STRIPE_SECRET_KEY is not set");
    return NextResponse.json(
      { error: "Stripe configuration error" },
      { status: 500 },
    );
  }

  const stripe = requireStripe();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    logger.error("[Stripe Webhook] Signature verification failed");
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  logger.info(`[Stripe Webhook] Received event: ${event.type} (${event.id})`);

  // Handle the event
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          const organizationId = session.metadata?.organization_id;
          const userId = session.metadata?.user_id;
          const creditsStr = session.metadata?.credits || "0";
          const credits = parseAndValidateCredits(creditsStr);
          const paymentIntentId = session.payment_intent as string;
          const purchaseType = session.metadata?.type || "checkout";
          const purchaseSource = session.metadata?.source;
          const appId = session.metadata?.app_id;

          // Check if this is an app-specific purchase
          const isAppPurchase =
            purchaseSource === "miniapp_app" && appId && userId;

          if (!organizationId || !credits) {
            logger.warn(
              `[Stripe Webhook] Permanent failure - Invalid metadata in checkout session ${session.id}`,
              { hasOrgId: !!organizationId, hasValidCredits: !!credits },
            );
            return NextResponse.json(
              {
                received: true,
                error: "Invalid metadata",
                skipped: true,
              },
              { status: 200 },
            );
          }

          if (!paymentIntentId) {
            logger.warn(
              `[Stripe Webhook] Permanent failure - No payment intent ID in checkout session ${session.id}`,
            );
            return NextResponse.json(
              {
                received: true,
                error: "No payment intent ID",
                skipped: true,
              },
              { status: 200 },
            );
          }

          const existingTransaction =
            await creditsService.getTransactionByStripePaymentIntent(
              paymentIntentId,
            );

          if (existingTransaction) {
            logger.debug(
              `[Stripe Webhook] Duplicate event - Payment intent ${paymentIntentId} already processed`,
            );
            return NextResponse.json(
              { received: true, duplicate: true },
              { status: 200 },
            );
          }

          // Handle app-specific purchases with creator monetization
          if (isAppPurchase) {
            logger.info(
              `[Stripe Webhook] Processing app-specific credit purchase for app ${appId}`,
            );

            try {
              const result = await appCreditsService.processPurchase({
                appId,
                userId,
                organizationId,
                purchaseAmount: credits,
                stripePaymentIntentId: paymentIntentId,
              });

              logger.info(
                `[Stripe Webhook] App credits added: ${result.creditsAdded} to app ${appId} for user ${userId}`,
                {
                  creditsAdded: result.creditsAdded,
                  platformOffset: result.platformOffset,
                  creatorEarnings: result.creatorEarnings,
                  newBalance: result.newBalance,
                },
              );

              // Track app credits purchased in PostHog
              trackServerEvent(userId, "app_credits_purchased", {
                app_id: appId,
                amount: credits,
                credits_added: result.creditsAdded,
                organization_id: organizationId,
                platform_offset: result.platformOffset,
                creator_earnings: result.creatorEarnings,
              });

              // Also track unified checkout_completed for funnel analysis
              trackServerEvent(userId, "checkout_completed", {
                payment_method: "stripe",
                amount: credits,
                currency: session.currency || "usd",
                organization_id: organizationId,
                purchase_type: "app_credits",
                credits_added: result.creditsAdded,
                stripe_session_id: session.id,
              });

              // Also create a record in regular credit transactions for audit trail
              await creditsService.addCredits({
                organizationId,
                amount: 0, // Don't add to org balance - it's in app-specific balance
                description: `App credit purchase (App: ${appId}) - $${credits.toFixed(2)}`,
                metadata: {
                  user_id: userId,
                  app_id: appId,
                  payment_intent_id: paymentIntentId,
                  session_id: session.id,
                  type: purchaseType,
                  source: purchaseSource,
                  credits_to_app_balance: credits,
                  platform_offset: result.platformOffset,
                  creator_earnings: result.creatorEarnings,
                },
                stripePaymentIntentId: paymentIntentId,
              });
            } catch (appError) {
              logger.error(
                "[Stripe Webhook] Error processing app credit purchase",
                appError,
              );
              // Fall through to regular credit addition as fallback
              await creditsService.addCredits({
                organizationId,
                amount: credits,
                description: `Balance top-up (app purchase fallback) - $${credits.toFixed(2)}`,
                metadata: {
                  user_id: userId,
                  app_id: appId,
                  payment_intent_id: paymentIntentId,
                  session_id: session.id,
                  type: purchaseType,
                  fallback: true,
                },
                stripePaymentIntentId: paymentIntentId,
              });
            }
          } else {
            // Regular credit purchase (not app-specific)
            await creditsService.addCredits({
              organizationId,
              amount: credits,
              description: `Balance top-up - $${credits.toFixed(2)}`,
              metadata: {
                user_id: userId,
                payment_intent_id: paymentIntentId,
                session_id: session.id,
                type: purchaseType,
              },
              stripePaymentIntentId: paymentIntentId,
            });

            logger.info(
              `[Stripe Webhook] Credits added: ${credits} to org ${organizationId}`,
            );

            // Track credits purchased in PostHog using internal UUID
            if (userId) {
              trackServerEvent(userId, "credits_purchased", {
                amount: credits,
                currency: session.currency || "usd",
                purchase_type: purchaseType,
                organization_id: organizationId,
                payment_method: "stripe",
              });

              // Also track unified checkout_completed event
              trackServerEvent(userId, "checkout_completed", {
                payment_method: "stripe",
                amount: credits,
                currency: session.currency || "usd",
                organization_id: organizationId,
                purchase_type: purchaseType,
                credits_added: credits,
                stripe_session_id: session.id,
              });
            }

            // Log payment to Discord (fire and forget)
            organizationsRepository.findById(organizationId).then((org) => {
              const user = userId
                ? usersRepository.findById(userId)
                : Promise.resolve(null);
              user.then((userData) => {
                discordService
                  .logPaymentReceived({
                    paymentId: paymentIntentId,
                    amount: credits,
                    currency: session.currency || "usd",
                    credits,
                    organizationId,
                    organizationName: org?.name,
                    userId: userId || undefined,
                    userName: userData?.name || userData?.email,
                    paymentMethod: "stripe",
                    paymentType:
                      purchaseType === "credit_pack"
                        ? "Credit Pack"
                        : "Balance Top-up",
                  })
                  .catch((err) => {
                    logger.error(
                      "[Stripe Webhook] Failed to log payment to Discord",
                      { error: err },
                    );
                  });
              });
            });
          }

          // Process referral commission if this user was referred
          if (userId) {
            const referralSignup =
              await referralSignupsRepository.findByReferredUserId(userId);
            if (referralSignup) {
              const referrerUser = await usersRepository.findById(
                referralSignup.referrer_user_id,
              );
              if (referrerUser?.organization_id) {
                const commission =
                  await referralsService.processReferralCommission(
                    userId,
                    credits,
                    referrerUser.organization_id,
                  );
                if (commission > 0) {
                  logger.info(
                    `[Stripe Webhook] Referral commission credited: $${commission.toFixed(2)} to org ${referrerUser.organization_id}`,
                  );
                }
              }
            }
          }

          try {
            const existingInvoice = await invoicesService.getByStripeInvoiceId(
              `cs_${session.id}`,
            );

            if (!existingInvoice) {
              const amountTotal = session.amount_total
                ? (session.amount_total / 100).toString()
                : credits.toString();

              await invoicesService.create({
                organization_id: organizationId,
                stripe_invoice_id: `cs_${session.id}`,
                stripe_customer_id: session.customer as string,
                stripe_payment_intent_id: paymentIntentId,
                amount_due: amountTotal,
                amount_paid: amountTotal,
                currency: session.currency || "usd",
                status: "paid",
                invoice_type: purchaseType,
                invoice_number: undefined,
                invoice_pdf: undefined,
                hosted_invoice_url: undefined,
                credits_added: credits.toString(),
                metadata: {
                  type: purchaseType,
                  session_id: session.id,
                  ...(appId && { app_id: appId }),
                },
                paid_at: new Date(),
              });

              logger.debug(
                `[Stripe Webhook] Invoice created for checkout session ${session.id}`,
              );
            } else {
              logger.debug(
                `[Stripe Webhook] Invoice already exists for checkout session ${session.id}`,
              );
            }
          } catch (invoiceError) {
            logger.error(
              "[Stripe Webhook] Non-critical error creating invoice record",
              invoiceError,
            );
          }
        }
        break;
      }

      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object;
        logger.debug(
          `[Stripe Webhook] Payment intent succeeded: ${paymentIntent.id}`,
        );

        // Only process if this is a one-time purchase or auto-top-up
        // Credit pack purchases are handled by checkout.session.completed
        const purchaseType = paymentIntent.metadata?.type;

        if (!purchaseType || purchaseType === "credit_pack") {
          logger.debug(
            `[Stripe Webhook] Skipping payment intent ${paymentIntent.id} - type: ${purchaseType || "unknown"}`,
          );
          break;
        }

        const organizationId = paymentIntent.metadata?.organization_id;
        const creditsStr = paymentIntent.metadata?.credits;
        const credits = creditsStr ? parseAndValidateCredits(creditsStr) : null;

        if (!organizationId || !credits) {
          logger.warn(
            `[Stripe Webhook] Permanent failure - Invalid metadata in payment intent ${paymentIntent.id}`,
            { hasOrgId: !!organizationId, hasValidCredits: !!credits },
          );
          // Return 200 to prevent retries for permanent failures (bad data)
          return NextResponse.json(
            {
              received: true,
              error: "Invalid metadata",
              skipped: true,
            },
            { status: 200 },
          );
        }

        // Check for duplicate transaction
        const existingTransaction =
          await creditsService.getTransactionByStripePaymentIntent(
            paymentIntent.id,
          );

        if (existingTransaction) {
          logger.debug(
            `[Stripe Webhook] Duplicate event - Payment intent ${paymentIntent.id} already processed`,
          );
          return NextResponse.json(
            { received: true, duplicate: true },
            { status: 200 },
          );
        }

        // Determine description based on purchase type
        const description =
          purchaseType === "auto_top_up"
            ? `Auto top-up - $${credits.toFixed(2)}`
            : `One-time purchase - $${credits.toFixed(2)}`;

        // Add credits
        await creditsService.addCredits({
          organizationId,
          amount: credits,
          description,
          metadata: {
            type: purchaseType,
            payment_intent_id: paymentIntent.id,
          },
          stripePaymentIntentId: paymentIntent.id,
        });

        logger.info(
          `[Stripe Webhook] Credits added: ${credits} to org ${organizationId} (${purchaseType})`,
        );

        // Log payment to Discord (fire and forget)
        organizationsRepository.findById(organizationId).then((org) => {
          discordService
            .logPaymentReceived({
              paymentId: paymentIntent.id,
              amount: credits,
              currency: paymentIntent.currency,
              credits,
              organizationId,
              organizationName: org?.name,
              paymentMethod: "stripe",
              paymentType:
                purchaseType === "auto_top_up"
                  ? "Auto Top-up"
                  : "One-time Purchase",
            })
            .catch((err) => {
              logger.error(
                "[Stripe Webhook] Failed to log payment to Discord",
                { error: err },
              );
            });
        });

        try {
          // Type-safe handling of invoice property using type guard
          // PaymentIntent.invoice can be string | Stripe.Invoice | null when expanded
          const invoiceIdOrObject = (
            paymentIntent as Stripe.PaymentIntent & {
              invoice?: string | Stripe.Invoice | null;
            }
          ).invoice;
          if (invoiceIdOrObject) {
            // Extract the invoice ID using type guard for expanded invoice
            const invoiceId = isInvoiceExpanded(invoiceIdOrObject)
              ? invoiceIdOrObject.id
              : invoiceIdOrObject;

            const existingInvoice =
              await invoicesService.getByStripeInvoiceId(invoiceId);

            if (!existingInvoice) {
              const stripeInvoice = await stripe.invoices.retrieve(invoiceId);

              await invoicesService.create({
                organization_id: organizationId,
                stripe_invoice_id: stripeInvoice.id,
                stripe_customer_id: stripeInvoice.customer as string,
                stripe_payment_intent_id: paymentIntent.id,
                amount_due: (stripeInvoice.amount_due / 100).toString(),
                amount_paid: (stripeInvoice.amount_paid / 100).toString(),
                currency: stripeInvoice.currency,
                status: stripeInvoice.status || "draft",
                invoice_type: purchaseType || "one_time_purchase",
                invoice_number: stripeInvoice.number || undefined,
                invoice_pdf: stripeInvoice.invoice_pdf || undefined,
                hosted_invoice_url:
                  stripeInvoice.hosted_invoice_url || undefined,
                credits_added: credits.toString(),
                metadata: {
                  type: purchaseType,
                },
                paid_at: stripeInvoice.status_transitions?.paid_at
                  ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
                  : undefined,
              });

              logger.debug(
                `[Stripe Webhook] Invoice created for payment intent ${paymentIntent.id}`,
              );
            }
          } else {
            // Check if invoice already exists (might have been created synchronously)
            const existingInvoice = await invoicesService.getByStripeInvoiceId(
              `pi_${paymentIntent.id}`,
            );

            if (!existingInvoice) {
              await invoicesService.create({
                organization_id: organizationId,
                stripe_invoice_id: `pi_${paymentIntent.id}`,
                stripe_customer_id: paymentIntent.customer as string,
                stripe_payment_intent_id: paymentIntent.id,
                amount_due: (paymentIntent.amount / 100).toString(),
                amount_paid: (paymentIntent.amount_received / 100).toString(),
                currency: paymentIntent.currency,
                status: "paid",
                invoice_type: purchaseType || "one_time_purchase",
                invoice_number: undefined,
                invoice_pdf: undefined,
                hosted_invoice_url: undefined,
                credits_added: credits.toString(),
                metadata: {
                  type: purchaseType,
                },
                paid_at: new Date(),
              });

              logger.debug(
                `[Stripe Webhook] Invoice created for direct payment ${paymentIntent.id}`,
              );
            } else {
              logger.debug(
                `[Stripe Webhook] Invoice already exists for payment ${paymentIntent.id}`,
              );
            }
          }
        } catch (invoiceError) {
          // Invoice creation failure is not critical - log but don't fail the webhook
          // The credits were already added successfully
          logger.error(
            "[Stripe Webhook] Non-critical error creating invoice record",
            invoiceError,
          );
        }

        break;
      }

      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        logger.warn(
          `[Stripe Webhook] Payment intent failed: ${paymentIntent.id}`,
        );

        // Track payment failure in PostHog
        const orgId = paymentIntent.metadata?.organization_id;
        const userId = paymentIntent.metadata?.user_id;
        const purchaseType = paymentIntent.metadata?.type;
        // The intended credits amount from metadata (not a "failed amount")
        const intendedCredits = paymentIntent.metadata?.credits
          ? parseAndValidateCredits(paymentIntent.metadata.credits)
          : null;

        // Get error reason from the payment intent
        const lastPaymentError = paymentIntent.last_payment_error;
        const errorReason =
          lastPaymentError?.message ||
          lastPaymentError?.code ||
          "Payment failed";

        // Use org-prefixed ID as fallback when user ID is missing (matches auto-top-up pattern)
        const trackingId = userId || (orgId ? `org:${orgId}` : null);

        if (trackingId && orgId) {
          trackServerEvent(trackingId, "checkout_failed", {
            payment_method: "stripe",
            amount: intendedCredits || undefined,
            currency: paymentIntent.currency || "usd",
            organization_id: orgId,
            purchase_type: purchaseType,
            error_reason: errorReason,
            stripe_payment_intent_id: paymentIntent.id,
          });
        } else {
          // Log warning when metadata is missing - creates blind spot in failure analytics
          logger.warn(
            `[Stripe Webhook] Cannot track checkout_failed - missing metadata`,
            {
              paymentIntentId: paymentIntent.id,
              hasUserId: !!userId,
              hasOrgId: !!orgId,
              errorReason,
            },
          );
        }

        break;
      }

      default:
        logger.debug(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      `[Stripe Webhook] Error processing event ${event.type} (${event.id}):`,
      errorMessage,
    );

    // Only log stack traces in development to prevent information disclosure
    if (process.env.NODE_ENV !== "production") {
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.debug("[Stripe Webhook] Error stack:", errorStack);
    }

    // Determine if error is permanent or transient
    const isPermanentError =
      error instanceof Error &&
      (error.message.includes("not found") ||
        error.message.includes("Invalid") ||
        error.message.includes("already processed") ||
        error.message.includes("duplicate"));

    if (isPermanentError) {
      // Return 200 for permanent errors to prevent retries
      logger.warn(
        "[Stripe Webhook] Permanent error detected, returning 200 to prevent retries",
      );
      return NextResponse.json(
        {
          received: true,
          error: "Permanent error",
          message: errorMessage,
          event_id: event.id,
          event_type: event.type,
        },
        { status: 200 },
      );
    }

    // Return 500 for transient errors to trigger Stripe retry logic
    // (database issues, network issues, temporary service unavailability)
    logger.warn(
      "[Stripe Webhook] Transient error detected, returning 500 to trigger retry",
    );
    return NextResponse.json(
      {
        error: "Transient error - will retry",
        message: errorMessage,
        event_id: event.id,
        event_type: event.type,
      },
      { status: 500 },
    );
  }
}

// Export rate-limited handler
export const POST = withRateLimit(
  handleStripeWebhook,
  RateLimitPresets.AGGRESSIVE,
);
