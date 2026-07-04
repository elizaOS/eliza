// Defines cloud shared ja behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud クレジット",
  topupDescription: (amount: number) => `Eliza Cloud クレジットのチャージ：$${amount}`,
};
