import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud 크레딧",
  topupDescription: (amount: number) => `Eliza Cloud 크레딧 충전: $${amount}`,
};
