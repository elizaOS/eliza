import { describe, expect, test } from "bun:test";
import {
  type NewPaymentRequest,
  type PaymentRequestRow,
  PaymentRequestsRepository,
} from "../../db/repositories/payment-requests";
import { createPaymentRequestsService } from "./payment-requests";

class GuardedPaymentRequestsRepository extends PaymentRequestsRepository {
  createCalls = 0;

  override async createPaymentRequest(input: NewPaymentRequest): Promise<PaymentRequestRow> {
    this.createCalls += 1;
    throw new Error(`Unexpected payment request create for provider ${input.provider}`);
  }
}

describe("createPaymentRequestsService", () => {
  test("rejects providers without a real adapter before creating a row", async () => {
    const repository = new GuardedPaymentRequestsRepository();
    const service = createPaymentRequestsService({
      repository,
      adapters: [],
    });

    await expect(
      service.create({
        organizationId: "org-1",
        provider: "oxapay",
        amountCents: 500,
        currency: "USD",
        paymentContext: { kind: "any_payer" },
      }),
    ).rejects.toThrow("No adapter registered for provider: oxapay");

    expect(repository.createCalls).toBe(0);
  });
});
