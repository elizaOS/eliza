/**
 * English (en) Stripe / x402 product copy catalog. Source of truth.
 *
 * NOTE: `statement_descriptor` is Stripe-regulated and must stay short ASCII
 * — it is intentionally NOT included here. Only product name and description
 * are localized.
 */

export interface StripeProductMessages {
  creditsName: string;
  topupDescription: (amount: number) => string;
}

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud Credits",
  topupDescription: (amount: number) => `Eliza Cloud credit top-up: $${amount}`,
};
