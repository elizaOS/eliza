// Coordinates cloud service payment requests default behavior behind route handlers.
import { paymentRequestsRepository } from "../../db/repositories/payment-requests";
import { createOxaPayPaymentAdapter } from "./payment-adapters/oxapay";
import { createStripePaymentAdapter } from "./payment-adapters/stripe";
import { createPaymentRequestsService, type PaymentRequestsService } from "./payment-requests";

let singleton: PaymentRequestsService | null = null;

export function getPaymentRequestsService(_env?: unknown): PaymentRequestsService {
  singleton ??= createPaymentRequestsService({
    repository: paymentRequestsRepository,
    // Stripe (brand-trust fiat) + OxaPay (crypto) both top up credits through
    // this one surface + ledger (#10732).
    adapters: [createStripePaymentAdapter(), createOxaPayPaymentAdapter()],
  });
  return singleton;
}

export const paymentRequestsService = new Proxy({} as PaymentRequestsService, {
  get(_target, prop: string | symbol) {
    const service = getPaymentRequestsService();
    const value = service[prop as keyof PaymentRequestsService];
    return typeof value === "function" ? value.bind(service) : value;
  },
});
