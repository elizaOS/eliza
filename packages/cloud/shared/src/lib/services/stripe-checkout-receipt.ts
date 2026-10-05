import type Stripe from "stripe";
import type { LegacyStripeCheckoutReceipt, StripeCheckoutReceipt } from "./stripe-checkout-orders";

/** Projection only: the durable settlement service remains the authority. */
function checkoutReceipt(session: Stripe.Checkout.Session, paymentIntentId: string) {
  return {
    checkoutSessionId: session.id,
    paymentIntentId,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
    customerId:
      typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
  };
}

export function projectStripeCheckoutReceipt(
  session: Stripe.Checkout.Session,
  paymentIntentId: string,
  checkoutOrderId: string,
): StripeCheckoutReceipt {
  return {
    ...checkoutReceipt(session, paymentIntentId),
    checkoutOrderId,
    clientReferenceId: session.client_reference_id,
    metadataOrderId: session.metadata?.checkout_order_id ?? null,
  };
}

export function projectLegacyStripeCheckoutReceipt(
  session: Stripe.Checkout.Session,
  paymentIntentId: string,
): LegacyStripeCheckoutReceipt {
  return {
    ...checkoutReceipt(session, paymentIntentId),
    organizationId: session.metadata?.organization_id ?? null,
    initiatedByUserId: session.metadata?.user_id ?? null,
    purchaseType: session.metadata?.type ?? null,
    creditPackId: session.metadata?.credit_pack_id ?? null,
    claimedCredits: session.metadata?.credits ?? null,
  };
}
