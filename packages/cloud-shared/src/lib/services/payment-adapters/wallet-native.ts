import type { PaymentProviderAdapter } from "../payment-requests";

// Wave B stub. Real wallet-native (Solana / EVM signed-tx) integration lands in Wave H.
export const walletNativePaymentAdapter: PaymentProviderAdapter = {
  provider: "wallet_native",
  async createIntent({ request }) {
    return {
      hostedUrl: `https://stub.invalid/wallet_native/${request.id}`,
      providerIntent: {
        stub: true,
        provider: "wallet_native",
        paymentRequestId: request.id,
      },
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
