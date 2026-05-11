import { describe, expect, test, vi } from "vitest";
import type { SensitiveRequestDispatchRegistry } from "../../../sensitive-requests/dispatch-registry";
import {
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	type PaymentRequestEnvelope,
	type PaymentRequestsClient,
} from "../types";
import { deliverPaymentLinkAction } from "./deliver-payment-link";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";

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

function createRuntime(
	client: PaymentRequestsClient,
	registry: SensitiveRequestDispatchRegistry | null,
) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === PAYMENT_REQUESTS_CLIENT_SERVICE) return client;
			if (name === SENSITIVE_DISPATCH_REGISTRY_SERVICE) return registry;
			return null;
		},
	};
}

describe("DELIVER_PAYMENT_LINK", () => {
	test("dispatches via the registered adapter for an eligible target", async () => {
		const deliver = vi
			.fn()
			.mockResolvedValue({ delivered: true, target: "dm", channelId: "r1" });
		const adapter = { target: "dm" as const, deliver };
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn().mockReturnValue(adapter),
			list: vi.fn().mockReturnValue([adapter]),
		};
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(envelope()),
			cancel: vi.fn(),
		};

		const result = await deliverPaymentLinkAction.handler(
			createRuntime(client, registry) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "pay_1", target: "dm" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(deliver).toHaveBeenCalledTimes(1);
		const args = deliver.mock.calls[0][0];
		expect(args.request.id).toBe("pay_1");
		expect(args.request.kind).toBe("payment");
		expect(args.channelId).toBe("r1");
	});

	test("rejects ineligible delivery target for verified_payer", async () => {
		const deliver = vi.fn();
		const adapter = { target: "public_link" as const, deliver };
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn().mockReturnValue(adapter),
			list: vi.fn().mockReturnValue([adapter]),
		};
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi
				.fn()
				.mockResolvedValue(
					envelope({ paymentContext: { kind: "verified_payer" } }),
				),
			cancel: vi.fn(),
		};

		const result = await deliverPaymentLinkAction.handler(
			createRuntime(client, registry) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "pay_1", target: "public_link" },
			} as never,
		);

		expect(result.success).toBe(false);
		expect(deliver).not.toHaveBeenCalled();
		expect(result.text).toContain("not eligible");
	});

	test("returns failure when payment request not found", async () => {
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn(),
			list: vi.fn().mockReturnValue([]),
		};
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(null),
			cancel: vi.fn(),
		};

		const result = await deliverPaymentLinkAction.handler(
			createRuntime(client, registry) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "missing", target: "dm" },
			} as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("not found");
	});
});
