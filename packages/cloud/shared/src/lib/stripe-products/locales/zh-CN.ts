// Defines cloud shared zh cN behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud 积分",
  topupDescription: (amount: number) => `Eliza Cloud 积分充值：$${amount}`,
};
