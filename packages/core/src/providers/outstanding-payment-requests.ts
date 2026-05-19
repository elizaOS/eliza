/**
 * Outstanding Payment Requests Provider
 *
 * Surfaces the user's currently-pending payment requests via a
 * runtime-injected `PaymentRequestsClient`. Returns `{ requests: [] }` when
 * the client is absent — never throws.
 *
 * Position: -10.
 *
 * Note: the client interface here is a planner-facing subset (`listOutstanding`)
 * and may be implemented by the same cloud adapter that backs the PAYMENT
 * action's `PaymentRequestsClient`. Keeping the subset local to this provider
 * keeps the dependency surface narrow.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types/index.ts";

export const PAYMENT_REQUESTS_CLIENT_SERVICE = "PaymentRequestsClient";

export interface OutstandingPaymentRequest {
	paymentRequestId: string;
	provider: string;
	amountCents: number;
	currency: string;
	status: string;
	expiresAt: number;
	reason?: string;
}

export interface OutstandingPaymentRequestsClient {
	listOutstanding(identityId: string): Promise<OutstandingPaymentRequest[]>;
}

export const outstandingPaymentRequestsProvider: Provider = {
	name: "OUTSTANDING_PAYMENT_REQUESTS",
	description: "Lists the user's currently-pending payment requests.",
	position: -10,
	dynamic: true,
	contexts: ["payments", "agent_internal"],
	contextGate: { anyOf: ["payments", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const client = runtime.getService(
			PAYMENT_REQUESTS_CLIENT_SERVICE,
		) as unknown as OutstandingPaymentRequestsClient | null;
		const identityId =
			typeof message.entityId === "string" ? message.entityId : undefined;

		if (
			!client ||
			!identityId ||
			typeof client.listOutstanding !== "function"
		) {
			return {
				text: "",
				data: { requests: [] as OutstandingPaymentRequest[] },
				values: { outstandingPaymentRequestCount: 0 },
			};
		}

		const requests = await client.listOutstanding(identityId);
		const text =
			requests.length === 0
				? ""
				: `[Outstanding Payments] ${requests.length} pending: ${requests
						.map(
							(r) =>
								`${r.amountCents} ${r.currency} via ${r.provider} (${r.status})`,
						)
						.join("; ")}`;

		return {
			text,
			data: { requests },
			values: { outstandingPaymentRequestCount: requests.length },
		};
	},
};

export default outstandingPaymentRequestsProvider;
