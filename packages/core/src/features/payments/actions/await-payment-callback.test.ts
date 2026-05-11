import { describe, expect, test, vi } from "vitest";
import { PAYMENT_BUS_CLIENT_SERVICE, type PaymentBusClient } from "../types";
import { awaitPaymentCallbackAction } from "./await-payment-callback";

function createRuntime(bus: PaymentBusClient | null) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === PAYMENT_BUS_CLIENT_SERVICE ? bus : null,
	};
}

describe("AWAIT_PAYMENT_CALLBACK", () => {
	test("returns sanitized settlement and never leaks raw proof", async () => {
		// Bus returns extra fields that must NOT be propagated.
		const waitFor = vi.fn().mockResolvedValue({
			paymentRequestId: "pay_1",
			status: "settled",
			txRef: "0xabc",
			payerIdentityId: "user-9",
			amountCents: 1000,
			settledAt: 123,
			// rogue field that must not leak:
			rawProof: { secret: "do-not-leak" },
		});
		const bus: PaymentBusClient = { waitFor, verifyProof: vi.fn() };
		const result = await awaitPaymentCallbackAction.handler(
			createRuntime(bus) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{ parameters: { paymentRequestId: "pay_1", timeoutMs: 1000 } } as never,
		);

		expect(result.success).toBe(true);
		expect(waitFor).toHaveBeenCalledWith("pay_1", 1000);
		const settlement = result.data?.settlement as Record<string, unknown>;
		expect(settlement.txRef).toBe("0xabc");
		expect(settlement.payerIdentityId).toBe("user-9");
		expect(settlement).not.toHaveProperty("rawProof");
	});

	test("uses default 10-minute timeout when not provided", async () => {
		const waitFor = vi.fn().mockResolvedValue({
			paymentRequestId: "pay_1",
			status: "expired",
		});
		const bus: PaymentBusClient = { waitFor, verifyProof: vi.fn() };
		await awaitPaymentCallbackAction.handler(
			createRuntime(bus) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{ parameters: { paymentRequestId: "pay_1" } } as never,
		);
		expect(waitFor).toHaveBeenCalledWith("pay_1", 10 * 60 * 1000);
	});

	test("returns failure for non-settled terminal status", async () => {
		const bus: PaymentBusClient = {
			waitFor: vi.fn().mockResolvedValue({
				paymentRequestId: "pay_1",
				status: "expired",
			}),
			verifyProof: vi.fn(),
		};
		const result = await awaitPaymentCallbackAction.handler(
			createRuntime(bus) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{ parameters: { paymentRequestId: "pay_1" } } as never,
		);
		expect(result.success).toBe(false);
	});
});
