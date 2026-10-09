// Defines cloud shared ja behavior for backend service consumers.
import type { StripeProductMessages } from "./en";

export const stripeProductMessages: StripeProductMessages = {
  creditsName: "Eliza Cloud クレジット",
  topupDescription: (amount: number) => `Eliza Cloud クレジットのチャージ：$${amount}`,
  cryptoRefundPolicy:
    "返金は Eliza Cloud クレジットでのみ行われ、オンチェーンや法定通貨で返金されることはありません。",
};
