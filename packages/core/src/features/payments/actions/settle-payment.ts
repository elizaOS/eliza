/**
 * SETTLE_PAYMENT — atomic payment action.
 *
 * For non-webhook providers (e.g. `wallet_native`) where the agent must
 * explicitly settle the request after verifying a proof, this calls the
 * runtime-injected `PaymentSettler.settle`. Returns a `PaymentSettlementResult`.
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
import { PAYMENT_SETTLER_SERVICE, type PaymentSettler } from "../types.ts";

interface RawSettleParams {
	paymentRequestId?: unknown;
	proof?: unknown;
	strategy?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawSettleParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as RawSettleParams;
}

export const settlePaymentAction: Action = {
	name: "SETTLE_PAYMENT",
	suppressPostActionContinuation: true,
	similes: ["FINALIZE_PAYMENT", "CONFIRM_PAYMENT"],
	description:
		"Explicitly settle a payment request via the runtime payment settler. Used for providers that do not deliver webhook callbacks (e.g. wallet_native).",
	parameters: [
		{
			name: "paymentRequestId",
			description: "ID of the payment request to settle.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "proof",
			description: "Optional provider-specific proof payload.",
			required: false,
			schema: { type: "object" as const },
		},
		{
			name: "strategy",
			description: "Optional settler strategy hint.",
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
		if (runtime.getService(PAYMENT_SETTLER_SERVICE) === null) {
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
		const settler = runtime.getService(
			PAYMENT_SETTLER_SERVICE,
		) as unknown as PaymentSettler | null;
		if (!settler) {
			return {
				success: false,
				text: "PaymentSettler not available",
				data: { actionName: "SETTLE_PAYMENT" },
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
				data: { actionName: "SETTLE_PAYMENT" },
			};
		}

		const settlement = await settler.settle({
			paymentRequestId,
			proof: params.proof,
			strategy:
				typeof params.strategy === "string" ? params.strategy : undefined,
		});

		logger.info(
			`[SettlePayment] requestId=${paymentRequestId} status=${settlement.status}`,
		);

		const text =
			settlement.status === "settled"
				? `Payment ${paymentRequestId} settled${settlement.txRef ? ` (tx ${settlement.txRef})` : ""}.`
				: `Payment ${paymentRequestId} settle attempt ended with status ${settlement.status}${settlement.error ? `: ${settlement.error}` : ""}.`;

		if (callback) {
			await callback({ text, action: "SETTLE_PAYMENT" });
		}

		return {
			success: settlement.status === "settled",
			text,
			data: {
				actionName: "SETTLE_PAYMENT",
				settlement,
			},
		};
	},

	examples: [],
};
