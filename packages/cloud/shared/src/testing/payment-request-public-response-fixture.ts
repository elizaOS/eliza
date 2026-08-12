/** Canonical public payment response shared by backend and UI contract tests. */
import type { PublicPaymentRequest } from "../lib/services/payment-requests";

export const publicPaymentRequestActiveExpiry = "9999-12-31T23:59:59.999Z";

export const publicPaymentRequestResponseFixture: {
  success: true;
  paymentRequest: PublicPaymentRequest;
} = {
  success: true,
  paymentRequest: {
    id: "00000000-0000-4000-8000-000000018814",
    provider: "stripe",
    amountCents: 2500,
    currency: "USD",
    reason: "Premium plan",
    status: "delivered",
    hostedUrl: "https://checkout.example.test/session",
    expiresAt: publicPaymentRequestActiveExpiry,
  },
};
