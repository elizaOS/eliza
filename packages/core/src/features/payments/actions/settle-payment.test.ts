import { describe, expect, test, vi } from "vitest";
import { PAYMENT_SETTLER_SERVICE, type PaymentSettler } from "../types";
import { settlePaymentAction } from "./settle-payment";

function createRuntime(settler: PaymentSettler | null) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === PAYMENT_SETTLER_SERVICE ? settler : null,
	};
}

describe("SETTLE_PAYMENT", () => {
	test("settles via runtime settler and returns settlement", async () => {
		const settle = vi.fn().mockResolvedValue({
			paymentRequestId: "pay_1",
			status: "settled",
			txRef: "0xdeadbeef",
		});
		const settler: PaymentSettler = { settle };
		const result = await settlePaymentAction.handler(
			createRuntime(settler) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{
				parameters: {
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

	test("returns failure when settler reports failed status", async () => {
		const settler: PaymentSettler = {
			settle: vi.fn().mockResolvedValue({
				paymentRequestId: "pay_1",
				status: "failed",
				error: "rejected",
			}),
		};
		const result = await settlePaymentAction.handler(
			createRuntime(settler) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{ parameters: { paymentRequestId: "pay_1" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.settlement?.status).toBe("failed");
	});

	test("returns failure when settler service missing", async () => {
		const result = await settlePaymentAction.handler(
			createRuntime(null) as never,
			{ entityId: "u1", roomId: "r1", content: { text: "" } } as never,
			undefined,
			{ parameters: { paymentRequestId: "pay_1" } } as never,
		);
		expect(result.success).toBe(false);
	});
});
