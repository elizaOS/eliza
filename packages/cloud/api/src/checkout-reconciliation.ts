/** Recovers an existing provider session without replaying checkout creation. */

import {
  STRIPE_CHECKOUT_PROVIDER_RETRY_WINDOW_MS,
  StripeCheckoutAuthorityError,
} from "@elizaos/cloud-shared/lib/services/stripe-checkout-orders";
import type Stripe from "stripe";

const CHECKOUT_RECONCILIATION_TIMEOUT_MS = 10_000;

export async function findCheckoutSessionForOrder(
  stripe: Stripe,
  order: {
    id: string;
    stripe_customer_id: string | null;
    created_at: Date;
    provider_started_at: Date | null;
  },
  now: () => number = Date.now,
): Promise<Stripe.Checkout.Session | null> {
  if (!order.stripe_customer_id) {
    throw new Error("Checkout order has no pinned Stripe customer");
  }
  // Retries may execute anywhere inside the original retention window. A
  // last-update window can miss an earlier accepted request (or a late retry).
  // Historical rows have no trustworthy first dispatch: search their complete
  // lifetime read-only, and let the caller refuse another create.
  const startedAt = order.provider_started_at?.getTime();
  const earliestCreationSeconds = Math.floor(
    (startedAt ?? order.created_at.getTime()) / 1000,
  );
  const latestCreationSeconds = Math.ceil(
    (startedAt === undefined
      ? now()
      : startedAt + STRIPE_CHECKOUT_PROVIDER_RETRY_WINDOW_MS) / 1000,
  );
  const deadlineAt = now() + CHECKOUT_RECONCILIATION_TIMEOUT_MS;
  let startingAfter: string | undefined;
  const seenCursors = new Set<string>();
  let match: Stripe.Checkout.Session | null = null;
  while (true) {
    if (now() >= deadlineAt) {
      throw new Error(
        "Stripe Checkout reconciliation exceeded its operation deadline",
      );
    }
    const sessions = await stripe.checkout.sessions.list({
      customer: order.stripe_customer_id,
      created: {
        gte: Math.max(0, earliestCreationSeconds - 3600),
        lte: latestCreationSeconds + 3600,
      },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (now() >= deadlineAt) {
      throw new Error(
        "Stripe Checkout reconciliation exceeded its operation deadline",
      );
    }
    for (const session of sessions.data) {
      if (
        session.client_reference_id !== order.id ||
        session.metadata?.checkout_order_id !== order.id
      )
        continue;
      if (match && match.id !== session.id) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_MULTIPLE_SESSIONS",
          "Stripe Checkout recovery found multiple Sessions for one order",
          { checkoutOrderId: order.id },
        );
      }
      match = session;
    }
    if (!sessions.has_more) return match;
    if (sessions.data.length === 0) {
      throw new Error(
        "Stripe Checkout reconciliation returned an empty continuation page",
      );
    }
    const nextCursor = sessions.data.at(-1)?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error(
        "Stripe Checkout reconciliation returned invalid pagination",
      );
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;
  }
}
