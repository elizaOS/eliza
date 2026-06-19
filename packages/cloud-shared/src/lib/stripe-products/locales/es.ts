import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Créditos de Eliza Cloud",
  topupDescription: (amount: number) => `Recarga de créditos de Eliza Cloud: $${amount}`,
};
