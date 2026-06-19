import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Créditos do Eliza Cloud",
  topupDescription: (amount: number) => `Recarga de créditos do Eliza Cloud: $${amount}`,
};
