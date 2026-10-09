// Defines cloud shared pt behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Créditos do Eliza Cloud",
  topupDescription: (amount: number) => `Recarga de créditos do Eliza Cloud: $${amount}`,
  cryptoRefundPolicy:
    "Os reembolsos são emitidos apenas como créditos do Eliza Cloud, nunca on-chain nem em moeda fiduciária.",
};
