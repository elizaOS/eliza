/**
 * Stripe payment provider adapter for the unified payment_requests flow.
 *
 * `createIntent` opens a Stripe Checkout session and returns the hosted URL.
 * `parseWebhook` verifies a Stripe webhook signature and extracts the
 * paired `paymentRequestId` (carried via `client_reference_id` /
 * `payment_intent.metadata.payment_request_id`).
 *
 * This is the real adapter — it intentionally replaces the placeholder
 * created by the Wave B-cloud-service worktree.
 */

import type Stripe from "stripe";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { paymentMethodsService } from "@/lib/services/payment-methods";
import {
  type PaymentProviderAdapter,
  type PaymentRequestRow,
} from "@/lib/services/payment-requests";
import { IgnoredWebhookEvent } from "@/lib/services/payment-webhook-errors";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";

interface RequestMetadata {
  successUrl?: string;
  cancelUrl?: string;
  productName?: string;
  productDescription?: string;
  customerEmail?: string;
}

function readMetadata(request: PaymentRequestRow): RequestMetadata {
  const meta = (request.metadata ?? {}) as Record<string, unknown>;
  const pickString = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return {
    successUrl: request.successUrl ?? pickString("success_url"),
    cancelUrl: request.cancelUrl ?? pickString("cancel_url"),
    productName: pickString("product_name"),
    productDescription: pickString("product_description") ?? request.reason ?? undefined,
    customerEmail: pickString("customer_email"),
  };
}

async function resolveCustomerId(request: PaymentRequestRow): Promise<string | undefined> {
  if (!request.payerOrganizationId) return undefined;
  try {
    const list = await paymentMethodsService.listPaymentMethods(request.payerOrganizationId);
    const customer = list[0]?.customer;
    if (typeof customer === "string") return customer;
    if (customer && typeof customer === "object" && "id" in customer) {
      return (customer as { id: string }).id;
    }
  } catch (error) {
    logger.warn("[StripePaymentAdapter] Failed to resolve existing Stripe customer", {
      paymentRequestId: request.id,
      organizationId: request.payerOrganizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

export function createStripePaymentAdapter(): PaymentProviderAdapter {
  return {
    provider: "stripe",

    async createIntent({ request }) {
      if (request.provider !== "stripe") {
        throw new Error(
          `StripePaymentAdapter received non-stripe payment request (provider=${request.provider})`,
        );
      }
      if (request.amountCents <= 0) {
        throw new Error("Stripe payment amount must be greater than zero");
      }

      const meta = readMetadata(request);
      if (!meta.successUrl || !meta.cancelUrl) {
        throw new Error("Stripe payment requires success_url and cancel_url in request metadata");
      }

      const stripe = requireStripe();
      const customerId = await resolveCustomerId(request);

      const sharedMetadata = {
        payment_request_id: request.id,
        provider: "stripe",
        ...(request.appId ? { app_id: request.appId } : {}),
        ...(request.payerUserId ? { payer_user_id: request.payerUserId } : {}),
        ...(request.payerOrganizationId
          ? { payer_organization_id: request.payerOrganizationId }
          : {}),
      } satisfies Stripe.MetadataParam;

      const productName = meta.productName ?? request.reason ?? "Payment";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: request.currency.toLowerCase(),
              product_data: {
                name: productName,
                ...(meta.productDescription ? { description: meta.productDescription } : {}),
              },
              unit_amount: request.amountCents,
            },
            quantity: 1,
          },
        ],
        success_url: meta.successUrl,
        cancel_url: meta.cancelUrl,
        client_reference_id: request.id,
        ...(customerId ? { customer: customerId } : {}),
        ...(!customerId && meta.customerEmail ? { customer_email: meta.customerEmail } : {}),
        metadata: sharedMetadata,
        payment_intent_data: { metadata: sharedMetadata },
      });

      const paymentIntent = session.payment_intent;
      const paymentIntentId =
        typeof paymentIntent === "string" ? paymentIntent : (paymentIntent?.id ?? null);

      logger.info("[StripePaymentAdapter] Created Checkout session", {
        paymentRequestId: request.id,
        sessionId: session.id,
        amountCents: request.amountCents,
      });

      return {
        hostedUrl: session.url ?? undefined,
        providerIntent: {
          stripe_session_id: session.id,
          stripe_payment_intent_id: paymentIntentId,
          stripe_checkout_url: session.url,
        },
      };
    },

    async parseWebhook({ rawBody, signature }) {
      if (!signature) {
        throw new Error("Stripe webhook missing stripe-signature header");
      }
      const webhookSecret = getCloudAwareEnv().STRIPE_WEBHOOK_SECRET?.trim();
      if (!webhookSecret) {
        throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
      }

      const stripe = requireStripe();
      const event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const paymentRequestId = extractPaymentRequestId(session);
          if (!paymentRequestId) {
            throw new IgnoredWebhookEvent(
              `Stripe ${event.type} event missing payment_request_id (id=${event.id})`,
            );
          }
          const txRef =
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : (session.payment_intent?.id ?? undefined);
          return {
            paymentRequestId,
            status: "settled" as const,
            txRef,
            proof: {
              stripe_event_id: event.id,
              stripe_event_type: event.type,
              stripe_session_id: session.id,
              stripe_payment_intent_id: txRef ?? null,
              stripe_amount_total: session.amount_total ?? null,
            },
          };
        }
        case "payment_intent.payment_failed": {
          const intent = event.data.object as Stripe.PaymentIntent;
          const paymentRequestId = intent.metadata?.payment_request_id;
          if (!paymentRequestId) {
            throw new IgnoredWebhookEvent(
              `Stripe ${event.type} event missing payment_request_id (id=${event.id})`,
            );
          }
          return {
            paymentRequestId,
            status: "failed" as const,
            txRef: intent.id,
            proof: {
              stripe_event_id: event.id,
              stripe_event_type: event.type,
              stripe_payment_intent_id: intent.id,
              stripe_failure_code: intent.last_payment_error?.code ?? null,
              stripe_failure_message: intent.last_payment_error?.message ?? null,
            },
          };
        }
        default:
          throw new IgnoredWebhookEvent(
            `Stripe event type ${event.type} is not handled by the unified payment adapter`,
          );
      }
    },
  };
}

function extractPaymentRequestId(session: Stripe.Checkout.Session): string | undefined {
  if (typeof session.client_reference_id === "string" && session.client_reference_id.length > 0) {
    return session.client_reference_id;
  }
  const fromMetadata = session.metadata?.payment_request_id;
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) return fromMetadata;
  return undefined;
}

/** Singleton adapter instance. */
export const stripePaymentAdapter = createStripePaymentAdapter();

/** Re-export for callers that want to extract the event id (used by webhook route for idempotency). */
export async function verifyStripeEventId(rawBody: string, signature: string): Promise<string> {
  const webhookSecret = getCloudAwareEnv().STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }
  const event = await requireStripe().webhooks.constructEventAsync(
    rawBody,
    signature,
    webhookSecret,
  );
  return event.id;
}
