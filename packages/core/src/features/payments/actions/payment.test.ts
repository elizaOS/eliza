import { describe, expect, test, vi } from "vitest";
import type { SensitiveRequestDispatchRegistry } from "../../../sensitive-requests/dispatch-registry";
import {
	PAYMENT_BUS_CLIENT_SERVICE,
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	PAYMENT_SETTLER_SERVICE,
	type PaymentBusClient,
	type PaymentRequestEnvelope,
	type PaymentRequestsClient,
	type PaymentSettler,
} from "../types";
import { paymentAction } from "./payment";

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

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("PAYMENT", () => {
	test("declares the consolidated payment discriminator", () => {
		expect(paymentAction.name).toBe("PAYMENT");
		const discriminator = paymentAction.parameters?.find(
			(parameter) => parameter.name === "action",
		);
		expect(discriminator?.schema).toMatchObject({
			enum: [
				"create_request",
				"deliver_link",
				"verify_payload",
				"settle",
				"await_callback",
				"cancel_request",
			],
		});
		expect(paymentAction.similes).toContain("CREATE_PAYMENT_REQUEST");
		expect(paymentAction.similes).toContain("CANCEL_PAYMENT_REQUEST");
	});

	test("create_request creates a request and returns eligible delivery targets", async () => {
		const create = vi.fn().mockResolvedValue(envelope());
		const callback = vi.fn();
		const client: PaymentRequestsClient = {
			create,
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "create_request",
					provider: "stripe",
					amountCents: 1000,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
			callback,
		);

		expect(result.success).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ action: "PAYMENT" }),
		);
		expect(result.data?.actionName).toBe("PAYMENT");
		expect(result.data?.paymentAction).toBe("create_request");
		expect(result.data?.paymentRequestId).toBe("pay_1");
		expect(result.data?.eligibleDeliveryTargets).toEqual([
			"public_link",
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		]);
	});

	test("create_request accepts legacy discriminator aliases without changing canonical output", async () => {
		const client: PaymentRequestsClient = {
			create: vi
				.fn()
				.mockResolvedValue(
					envelope({ paymentContext: { kind: "verified_payer" } }),
				),
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "CREATE_PAYMENT_REQUEST",
					provider: "stripe",
					amountCents: 500,
					paymentContext: { kind: "verified_payer" },
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.actionName).toBe("PAYMENT");
		expect(result.data?.paymentAction).toBe("create_request");
		expect(result.data?.eligibleDeliveryTargets).not.toContain("public_link");
	});

	test("create_request rejects invalid amountCents", async () => {
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "create_request",
					provider: "stripe",
					amountCents: -1,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("validate fails when the service for the selected action is missing", async () => {
		const ok = await paymentAction.validate?.(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "create_request",
					provider: "stripe",
					amountCents: 100,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
		);
		expect(ok).toBe(false);
	});

	test("deliver_link dispatches via the registered adapter for an eligible target", async () => {
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

		const result = await paymentAction.handler(
			createRuntime({
				[PAYMENT_REQUESTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "deliver_link",
					paymentRequestId: "pay_1",
					target: "dm",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(deliver).toHaveBeenCalledTimes(1);
		const args = deliver.mock.calls[0][0];
		expect(args.request.id).toBe("pay_1");
		expect(args.request.kind).toBe("payment");
		expect(args.channelId).toBe("r1");
	});

	test("deliver_link rejects ineligible delivery target for verified_payer", async () => {
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

		const result = await paymentAction.handler(
			createRuntime({
				[PAYMENT_REQUESTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "deliver_link",
					paymentRequestId: "pay_1",
					target: "public_link",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(deliver).not.toHaveBeenCalled();
		expect(result.text).toContain("not eligible");
	});

	test("deliver_link returns failure when payment request is not found", async () => {
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

		const result = await paymentAction.handler(
			createRuntime({
				[PAYMENT_REQUESTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "deliver_link",
					paymentRequestId: "missing",
					target: "dm",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("not found");
	});

	test("verify_payload returns valid and payerIdentity when bus accepts proof", async () => {
		const verifyProof = vi.fn().mockResolvedValue({
			valid: true,
			payerIdentity: "user-9",
		});
		const bus: PaymentBusClient = {
			waitFor: vi.fn(),
			verifyProof,
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "verify_payload",
					paymentRequestId: "pay_1",
					proof: { sig: "0xabc" },
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(verifyProof).toHaveBeenCalledWith("pay_1", { sig: "0xabc" });
		expect(result.data?.valid).toBe(true);
		expect(result.data?.payerIdentity).toBe("user-9");
	});

	test("verify_payload returns invalid when bus rejects proof", async () => {
		const bus: PaymentBusClient = {
			waitFor: vi.fn(),
			verifyProof: vi.fn().mockResolvedValue({
				valid: false,
				error: "bad signature",
			}),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "verify_payload",
					paymentRequestId: "pay_1",
					proof: "garbage",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.valid).toBe(false);
		expect(result.data?.error).toBe("bad signature");
	});

	test("settle settles via runtime settler and returns settlement", async () => {
		const settle = vi.fn().mockResolvedValue({
			paymentRequestId: "pay_1",
			status: "settled",
			txRef: "0xdeadbeef",
		});
		const settler: PaymentSettler = { settle };

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_SETTLER_SERVICE]: settler }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "settle",
					paymentRequestId: "pay_1",
					proof: { sig: "0x" },
					strategy: "wallet_native",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(settle).toHaveBeenCalledWith({
			paymentRequestId: "pay_1",
			proof: { sig: "0x" },
			strategy: "wallet_native",
		});
		expect(result.data?.settlement?.status).toBe("settled");
	});

	test("settle returns failure when settler reports failed status", async () => {
		const settler: PaymentSettler = {
			settle: vi.fn().mockResolvedValue({
				paymentRequestId: "pay_1",
				status: "failed",
				error: "rejected",
			}),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_SETTLER_SERVICE]: settler }) as never,
			message() as never,
			undefined,
			{ parameters: { action: "settle", paymentRequestId: "pay_1" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.settlement?.status).toBe("failed");
	});

	test("await_callback returns sanitized settlement and never leaks raw proof", async () => {
		const waitFor = vi.fn().mockResolvedValue({
			paymentRequestId: "pay_1",
			status: "settled",
			txRef: "0xabc",
			payerIdentityId: "user-9",
			amountCents: 1000,
			settledAt: 123,
			rawProof: { secret: "do-not-leak" },
		});
		const bus: PaymentBusClient = { waitFor, verifyProof: vi.fn() };

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "await_callback",
					paymentRequestId: "pay_1",
					timeoutMs: 1000,
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(waitFor).toHaveBeenCalledWith("pay_1", 1000);
		const settlement = result.data?.settlement as Record<string, unknown>;
		expect(settlement.txRef).toBe("0xabc");
		expect(settlement.payerIdentityId).toBe("user-9");
		expect(settlement).not.toHaveProperty("rawProof");
	});

	test("await_callback uses default 10-minute timeout when not provided", async () => {
		const waitFor = vi.fn().mockResolvedValue({
			paymentRequestId: "pay_1",
			status: "expired",
		});
		const bus: PaymentBusClient = { waitFor, verifyProof: vi.fn() };

		await paymentAction.handler(
			createRuntime({ [PAYMENT_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "await_callback",
					paymentRequestId: "pay_1",
				},
			} as never,
		);

		expect(waitFor).toHaveBeenCalledWith("pay_1", 10 * 60 * 1000);
	});

	test("await_callback returns failure for non-settled terminal status", async () => {
		const bus: PaymentBusClient = {
			waitFor: vi.fn().mockResolvedValue({
				paymentRequestId: "pay_1",
				status: "expired",
			}),
			verifyProof: vi.fn(),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "await_callback",
					paymentRequestId: "pay_1",
				},
			} as never,
		);

		expect(result.success).toBe(false);
	});

	test("cancel_request cancels via client and returns updated envelope", async () => {
		const cancel = vi.fn().mockResolvedValue(envelope({ status: "canceled" }));
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel,
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "cancel_request",
					paymentRequestId: "pay_1",
					reason: "user changed mind",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(cancel).toHaveBeenCalledWith("pay_1", "user changed mind");
		expect((result.data?.envelope as PaymentRequestEnvelope).status).toBe(
			"canceled",
		);
	});

	test("cancel_request returns failure when envelope status is not canceled", async () => {
		const client: PaymentRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn().mockResolvedValue(envelope({ status: "settled" })),
		};

		const result = await paymentAction.handler(
			createRuntime({ [PAYMENT_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "cancel_request",
					paymentRequestId: "pay_1",
				},
			} as never,
		);

		expect(result.success).toBe(false);
	});
});
