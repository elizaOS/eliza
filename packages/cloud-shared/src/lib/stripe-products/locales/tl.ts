import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud Credits",
  topupDescription: (amount: number) => `Top-up ng Eliza Cloud credits: $${amount}`,
};
