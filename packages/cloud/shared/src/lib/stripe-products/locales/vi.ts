// Defines cloud shared vi behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Credit Eliza Cloud",
  topupDescription: (amount: number) => `Nạp credit Eliza Cloud: $${amount}`,
  cryptoRefundPolicy:
    "Hoàn tiền chỉ được cấp dưới dạng credit Eliza Cloud, không bao giờ hoàn on-chain hoặc bằng tiền pháp định.",
};
