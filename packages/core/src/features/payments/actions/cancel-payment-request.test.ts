import { describe, expect, test, vi } from "vitest";
import {
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	type PaymentRequestEnvelope,
	type PaymentRequestsClient,
} from "../types";
import { cancelPaymentRequestAction } from "./cancel-payment-request";

function envelope(
	overrides: Partial<PaymentRequestEnvelope> = {},
): PaymentRequestEnvelope {
	return {
		paymentRequestId: "pay_1",
		provider: "stripe",
		amountCents: 1000,
		currency: "USD",
		paymentContext: { kind: "any_payer" },
		expiresAt: Date.now() + 60_000,
		status: "canceled",
		...overrides,
	};
}

function createRuntime(client: PaymentRequestsClient | null) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === PAYMENT_REQUESTS_CLIENT_SERVICE ? client : null,
	};
}

describe("CANCEL_PAYMENT_REQUEST", () => {
	test("cancels via client and returns updated envelope", async () => {
		const cancel = vi.fn().mockResolvedValue(envelope());
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel,
		};
		const result = await cancelPaymentRequestAction.handler(
			createRuntime(client) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "pay_1", reason: "user changed mind" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(cancel).toHaveBeenCalledWith("pay_1", "user changed mind");
		expect((result.data?.envelope as PaymentRequestEnvelope).status).toBe(
			"canceled",
		);
	});

	test("returns failure when envelope status is not canceled", async () => {
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn().mockResolvedValue(envelope({ status: "settled" })),
		};
		const result = await cancelPaymentRequestAction.handler(
			createRuntime(client) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{ parameters: { paymentRequestId: "pay_1" } } as never,
		);
		expect(result.success).toBe(false);
	});
});
