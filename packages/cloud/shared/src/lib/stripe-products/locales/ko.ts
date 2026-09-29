// Defines cloud shared ko behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud 크레딧",
  topupDescription: (amount: number) => `Eliza Cloud 크레딧 충전: $${amount}`,
  cryptoRefundPolicy:
    "환불은 Eliza Cloud 크레딧으로만 지급되며, 온체인이나 법정화폐로는 지급되지 않습니다.",
};
