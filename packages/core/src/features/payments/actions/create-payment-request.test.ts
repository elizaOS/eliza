import { describe, expect, test, vi } from "vitest";
import {
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	type PaymentRequestEnvelope,
	type PaymentRequestsClient,
} from "../types";
import { createPaymentRequestAction } from "./create-payment-request";

function envelope(
	overrides: Partial<PaymentRequestEnvelope> = {},
): PaymentRequestEnvelope {
	return {
		paymentRequestId: "pay_1",
		provider: "stripe",
		amountCents: 1000,
		currency: "USD",
		paymentContext: { kind: "any_payer" },
		hostedUrl: "https://pay.example/abc",
		expiresAt: Date.now() + 60_000,
		status: "pending",
		...overrides,
	};
}

function createRuntime(client: PaymentRequestsClient | null) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === PAYMENT_REQUESTS_CLIENT_SERVICE) return client;
			return null;
		},
	};
}

describe("CREATE_PAYMENT_REQUEST", () => {
	test("creates a request and returns eligible delivery targets for any_payer", async () => {
		const create = vi.fn().mockResolvedValue(envelope());
		const client: PaymentRequestsClient = {
			create,
			get: vi.fn(),
			cancel: vi.fn(),
		};
		const runtime = createRuntime(client);

		const result = await createPaymentRequestAction.handler(
			runtime as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: {
					provider: "stripe",
					amountCents: 1000,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(result.data?.paymentRequestId).toBe("pay_1");
		expect(result.data?.eligibleDeliveryTargets).toEqual([
			"public_link",
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		]);
	});

	test("verified_payer excludes public_link from eligible targets", async () => {
		const client: PaymentRequestsClient = {
			create: vi
				.fn()
				.mockResolvedValue(
					envelope({ paymentContext: { kind: "verified_payer" } }),
				),
			get: vi.fn(),
			cancel: vi.fn(),
		};
		const runtime = createRuntime(client);

		const result = await createPaymentRequestAction.handler(
			runtime as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: {
					provider: "stripe",
					amountCents: 500,
					paymentContext: { kind: "verified_payer" },
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.eligibleDeliveryTargets).not.toContain("public_link");
	});

	test("rejects invalid amountCents", async () => {
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
		};
		const runtime = createRuntime(client);

		const result = await createPaymentRequestAction.handler(
			runtime as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: {
					provider: "stripe",
					amountCents: -1,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("validate fails when client is missing", async () => {
		const runtime = createRuntime(null);
		const ok = await createPaymentRequestAction.validate?.(
			runtime as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: {
					provider: "stripe",
					amountCents: 100,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
		);
		expect(ok).toBe(false);
	});
});
