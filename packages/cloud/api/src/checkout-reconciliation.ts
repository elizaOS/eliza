/** Recovers an existing provider session without replaying checkout creation. */
import type Stripe from "stripe";

const CHECKOUT_RECONCILIATION_TIMEOUT_MS = 10_000;

export async function findCheckoutSessionForOrder(
  stripe: Stripe,
  order: {
    id: string;
    stripe_customer_id: string | null;
    updated_at: Date;
  },
  now: () => number = Date.now,
): Promise<Stripe.Checkout.Session | null> {
  if (!order.stripe_customer_id) {
    throw new Error("Checkout order has no pinned Stripe customer");
  }
  const providerAttemptSeconds = Math.floor(order.updated_at.getTime() / 1000);
  const deadlineAt = now() + CHECKOUT_RECONCILIATION_TIMEOUT_MS;
  let startingAfter: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    if (now() >= deadlineAt) {
      throw new Error(
        "Stripe Checkout reconciliation exceeded its operation deadline",
      );
    }
    const sessions = await stripe.checkout.sessions.list({
      customer: order.stripe_customer_id,
      created: {
        gte: Math.max(0, providerAttemptSeconds - 3600),
        lte: providerAttemptSeconds + 3600,
      },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (now() >= deadlineAt) {
      throw new Error(
        "Stripe Checkout reconciliation exceeded its operation deadline",
      );
    }
    const match = sessions.data.find(
      (session) =>
        session.client_reference_id === order.id &&
        session.metadata?.checkout_order_id === order.id,
    );
    if (match) return match;
    if (!sessions.has_more) return null;
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
