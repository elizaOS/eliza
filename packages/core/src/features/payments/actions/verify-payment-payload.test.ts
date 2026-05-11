import { describe, expect, test, vi } from "vitest";
import { PAYMENT_BUS_CLIENT_SERVICE, type PaymentBusClient } from "../types";
import { verifyPaymentPayloadAction } from "./verify-payment-payload";

function createRuntime(bus: PaymentBusClient | null) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === PAYMENT_BUS_CLIENT_SERVICE ? bus : null,
	};
}

describe("VERIFY_PAYMENT_PAYLOAD", () => {
	test("returns valid + payerIdentity when bus accepts proof", async () => {
		const verifyProof = vi.fn().mockResolvedValue({
			valid: true,
			payerIdentity: "user-9",
		});
		const bus: PaymentBusClient = {
			waitFor: vi.fn(),
			verifyProof,
		};
		const result = await verifyPaymentPayloadAction.handler(
			createRuntime(bus) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "pay_1", proof: { sig: "0xabc" } },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(verifyProof).toHaveBeenCalledWith("pay_1", { sig: "0xabc" });
		expect(result.data?.valid).toBe(true);
		expect(result.data?.payerIdentity).toBe("user-9");
	});

	test("returns invalid when bus rejects proof", async () => {
		const bus: PaymentBusClient = {
			waitFor: vi.fn(),
			verifyProof: vi.fn().mockResolvedValue({
				valid: false,
				error: "bad signature",
			}),
		};
		const result = await verifyPaymentPayloadAction.handler(
			createRuntime(bus) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "pay_1", proof: "garbage" },
			} as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.valid).toBe(false);
		expect(result.data?.error).toBe("bad signature");
	});

	test("validate fails when bus client missing", async () => {
		const ok = await verifyPaymentPayloadAction.validate?.(
			createRuntime(null) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: { paymentRequestId: "pay_1", proof: {} },
			} as never,
		);
		expect(ok).toBe(false);
	});
});
