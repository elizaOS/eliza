import type { PaymentProviderAdapter } from "../payment-requests";

// Wave B stub. Real x402 facilitator + on-chain settlement integration lands in Wave H.
export const x402PaymentAdapter: PaymentProviderAdapter = {
  provider: "x402",
  async createIntent({ request }) {
    return {
      hostedUrl: `https://stub.invalid/x402/${request.id}`,
      providerIntent: { stub: true, provider: "x402", paymentRequestId: request.id },
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
