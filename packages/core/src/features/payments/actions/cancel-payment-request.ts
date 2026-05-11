/**
 * CANCEL_PAYMENT_REQUEST — atomic payment action.
 *
 * Cancels a pending payment request via the runtime-injected
 * `PaymentRequestsClient.cancel`. Returns the updated envelope.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	type PaymentRequestsClient,
} from "../types.ts";

interface RawCancelParams {
	paymentRequestId?: unknown;
	reason?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawCancelParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as RawCancelParams;
}

export const cancelPaymentRequestAction: Action = {
	name: "CANCEL_PAYMENT_REQUEST",
	suppressPostActionContinuation: true,
	similes: ["VOID_PAYMENT_REQUEST", "ABORT_PAYMENT_REQUEST"],
	description:
		"Cancel a pending payment request. Returns the updated envelope with status=canceled.",
	parameters: [
		{
			name: "paymentRequestId",
			description: "ID of the payment request to cancel.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Optional cancellation reason.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService(PAYMENT_REQUESTS_CLIENT_SERVICE) === null) {
			return false;
		}
		const params = readParams(options);
		return (
			typeof params.paymentRequestId === "string" &&
			params.paymentRequestId.length > 0
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const client = runtime.getService(
			PAYMENT_REQUESTS_CLIENT_SERVICE,
		) as unknown as PaymentRequestsClient | null;
		if (!client) {
			return {
				success: false,
				text: "PaymentRequestsClient not available",
				data: { actionName: "CANCEL_PAYMENT_REQUEST" },
			};
		}

		const params = readParams(options);
		const paymentRequestId =
			typeof params.paymentRequestId === "string"
				? params.paymentRequestId
				: "";
		if (!paymentRequestId) {
			return {
				success: false,
				text: "Missing required parameter: paymentRequestId",
				data: { actionName: "CANCEL_PAYMENT_REQUEST" },
			};
		}

		const reason =
			typeof params.reason === "string" && params.reason.trim().length > 0
				? params.reason.trim()
				: undefined;

		const envelope = await client.cancel(paymentRequestId, reason);

		logger.info(
			`[CancelPaymentRequest] requestId=${paymentRequestId} status=${envelope.status}`,
		);

		const text = `Payment request ${paymentRequestId} is now ${envelope.status}.`;

		if (callback) {
			await callback({ text, action: "CANCEL_PAYMENT_REQUEST" });
		}

		return {
			success: envelope.status === "canceled",
			text,
			data: {
				actionName: "CANCEL_PAYMENT_REQUEST",
				envelope,
			},
		};
	},

	examples: [],
};
