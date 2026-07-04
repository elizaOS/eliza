// Defines cloud shared vi behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Credit Eliza Cloud",
  topupDescription: (amount: number) => `Nạp credit Eliza Cloud: $${amount}`,
};
