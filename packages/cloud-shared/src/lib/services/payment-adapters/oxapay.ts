import type { PaymentProviderAdapter } from "../payment-requests";

// Wave B stub. Real OxaPay invoice + IPN integration lands in Wave H.
export const oxapayPaymentAdapter: PaymentProviderAdapter = {
  provider: "oxapay",
  async createIntent({ request }) {
    return {
      hostedUrl: `https://stub.invalid/oxapay/${request.id}`,
      providerIntent: { stub: true, provider: "oxapay", paymentRequestId: request.id },
    };
  },
  async parseWebhook({ rawBody }) {
    const payload = JSON.parse(rawBody) as {
      paymentRequestId: string;
      status?: "settled" | "failed";
      txRef?: string;
    };
    return {
      paymentRequestId: payload.paymentRequestId,
      status: payload.status ?? "settled",
      txRef: payload.txRef,
      proof: { stub: true, raw: payload },
    };
  },
};
