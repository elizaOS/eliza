/**
 * VERIFY_PAYMENT_PAYLOAD — atomic payment action.
 *
 * Verifies a payment proof (e.g. an x402 payment header, a wallet-native
 * signature) for a known payment request via the runtime-injected
 * `PaymentBusClient.verifyProof`. The raw proof never returns to the
 * planner — only `{ valid, error?, payerIdentity? }`.
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

interface RawVerifyParams {
	paymentRequestId?: unknown;
	proof?: unknown;
}

function readParams(options: HandlerOptions | undefined): RawVerifyParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as RawVerifyParams;
}

export const verifyPaymentPayloadAction: Action = {
	name: "VERIFY_PAYMENT_PAYLOAD",
	suppressPostActionContinuation: true,
	similes: ["VERIFY_PAYMENT_PROOF", "CHECK_PAYMENT_PROOF"],
	description:
		"Verify an inbound payment proof (e.g. x402 header, wallet signature) for a stored payment request. Returns validity only — never echoes the proof.",
	parameters: [
		{
			name: "paymentRequestId",
			description: "ID of the payment request the proof is claimed against.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "proof",
			description: "Provider-specific proof payload to verify.",
			required: true,
			schema: { type: "object" as const },
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
			params.paymentRequestId.length > 0 &&
			params.proof !== undefined
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
				data: { actionName: "VERIFY_PAYMENT_PAYLOAD" },
			};
		}

		const params = readParams(options);
		const paymentRequestId =
			typeof params.paymentRequestId === "string"
				? params.paymentRequestId
				: "";
		if (!paymentRequestId || params.proof === undefined) {
			return {
				success: false,
				text: "Missing required parameters: paymentRequestId, proof",
				data: { actionName: "VERIFY_PAYMENT_PAYLOAD" },
			};
		}

		const verification = await bus.verifyProof(paymentRequestId, params.proof);

		logger.info(
			`[VerifyPaymentPayload] requestId=${paymentRequestId} valid=${verification.valid}`,
		);

		const text = verification.valid
			? `Payment proof for ${paymentRequestId} is valid.`
			: `Payment proof for ${paymentRequestId} is invalid${verification.error ? `: ${verification.error}` : ""}.`;

		if (callback) {
			await callback({ text, action: "VERIFY_PAYMENT_PAYLOAD" });
		}

		return {
			success: verification.valid,
			text,
			data: {
				actionName: "VERIFY_PAYMENT_PAYLOAD",
				paymentRequestId,
				valid: verification.valid,
				error: verification.error,
				payerIdentity: verification.payerIdentity,
			},
		};
	},

	examples: [],
};
