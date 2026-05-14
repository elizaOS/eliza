import { describe, expect, test } from "vitest";
import { outstandingPaymentRequestsProvider } from "./outstanding-payment-requests";

const message = {
	entityId: "user-1",
	roomId: "room-1",
	content: { text: "" },
};

describe("OUTSTANDING_PAYMENT_REQUESTS provider", () => {
	test("returns outstanding payment requests from the client", async () => {
		const client = {
			listOutstanding: async () => [
				{
					paymentRequestId: "p-1",
					provider: "stripe",
					amountCents: 1000,
					currency: "USD",
					status: "pending",
					expiresAt: Date.now() + 60_000,
				},
			],
		};
		const runtime = {
			agentId: "agent-1",
			getService: (name: string) =>
				name === "PaymentRequestsClient" ? client : null,
		};

		const result = await outstandingPaymentRequestsProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);

		const data = result.data as {
			requests: Array<{ paymentRequestId: string }>;
		};
		expect(data.requests).toHaveLength(1);
		expect(data.requests[0].paymentRequestId).toBe("p-1");
	});

	test("returns empty list when client service is absent", async () => {
		const runtime = { agentId: "agent-1", getService: () => null };
		const result = await outstandingPaymentRequestsProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		const data = result.data as { requests: unknown[] };
		expect(data.requests).toEqual([]);
		expect(result.text).toBe("");
	});

	test("returns empty list when client lacks listOutstanding method", async () => {
		const runtime = {
			agentId: "agent-1",
			getService: () => ({ create: async () => null }),
		};
		const result = await outstandingPaymentRequestsProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		const data = result.data as { requests: unknown[] };
		expect(data.requests).toEqual([]);
	});
});
