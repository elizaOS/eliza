/**
 * AWAIT_PAYMENT_CALLBACK — atomic payment action.
 *
 * Blocks (with a planner-visible timeout) waiting for the cloud callback bus
 * to deliver settlement for a payment request. Returns a sanitized
 * `PaymentSettlementResult` only — the raw provider proof is intentionally
 * dropped so it never reaches the planner prompt.
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
import { PAYMENT_BUS_CLIENT_SERVICE, type PaymentBusClient } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface RawAwaitParams {
	paymentRequestId?: unknown;
	timeoutMs?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawAwaitParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as RawAwaitParams;
}

export const awaitPaymentCallbackAction: Action = {
	name: "AWAIT_PAYMENT_CALLBACK",
	suppressPostActionContinuation: true,
	similes: ["WAIT_FOR_PAYMENT", "AWAIT_PAYMENT_SETTLEMENT"],
	description:
		"Wait for an asynchronous payment settlement callback. Default timeout: 10 minutes. Returns settlement status only — raw proof is never surfaced.",
	parameters: [
		{
			name: "paymentRequestId",
			description: "ID of the payment request to await.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "timeoutMs",
			description: "Wait timeout in milliseconds. Defaults to 600000 (10 min).",
			required: false,
			schema: { type: "number" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService(PAYMENT_BUS_CLIENT_SERVICE) === null) {
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
		const bus = runtime.getService(
			PAYMENT_BUS_CLIENT_SERVICE,
		) as unknown as PaymentBusClient | null;
		if (!bus) {
			return {
				success: false,
				text: "PaymentBusClient not available",
				data: { actionName: "AWAIT_PAYMENT_CALLBACK" },
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
				data: { actionName: "AWAIT_PAYMENT_CALLBACK" },
			};
		}

		const timeoutMs =
			typeof params.timeoutMs === "number" &&
			Number.isFinite(params.timeoutMs) &&
			params.timeoutMs > 0
				? params.timeoutMs
				: DEFAULT_TIMEOUT_MS;

		const settlement = await bus.waitFor(paymentRequestId, timeoutMs);

		logger.info(
			`[AwaitPaymentCallback] requestId=${paymentRequestId} status=${settlement.status}`,
		);

		// Defense in depth: ensure no raw proof field can leak through even if
		// the bus implementation accidentally adds one.
		const sanitized = {
			paymentRequestId: settlement.paymentRequestId,
			status: settlement.status,
			txRef: settlement.txRef,
			payerIdentityId: settlement.payerIdentityId,
			amountCents: settlement.amountCents,
			error: settlement.error,
			settledAt: settlement.settledAt,
		};

		const text =
			settlement.status === "settled"
				? `Payment ${paymentRequestId} settled.`
				: `Payment ${paymentRequestId} ended in status ${settlement.status}${settlement.error ? `: ${settlement.error}` : ""}.`;

		if (callback) {
			await callback({ text, action: "AWAIT_PAYMENT_CALLBACK" });
		}

		return {
			success: settlement.status === "settled",
			text,
			data: {
				actionName: "AWAIT_PAYMENT_CALLBACK",
				settlement: sanitized,
			},
		};
	},

	examples: [],
};
