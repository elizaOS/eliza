import { paymentRequestsRepository } from "../../db/repositories/payment-requests";
import { createStripePaymentAdapter } from "./payment-adapters/stripe";
import { createPaymentRequestsService, type PaymentRequestsService } from "./payment-requests";

let singleton: PaymentRequestsService | null = null;

export function getPaymentRequestsService(_env?: unknown): PaymentRequestsService {
  singleton ??= createPaymentRequestsService({
    repository: paymentRequestsRepository,
    adapters: [createStripePaymentAdapter()],
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
