// Defines cloud shared tl behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud Credits",
  topupDescription: (amount: number) => `Top-up ng Eliza Cloud credits: $${amount}`,
  cryptoRefundPolicy:
    "Ang mga refund ay ibinibigay lamang bilang Eliza Cloud credits, hindi kailanman on-chain o sa fiat.",
};
