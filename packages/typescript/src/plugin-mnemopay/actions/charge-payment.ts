/**
 * CHARGE_PAYMENT Action
 *
 * Creates an escrow payment charge. The amount is deducted from the agent's
 * wallet and held until settled or refunded.
 */

import { logger } from "../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../types/index.ts";
import type { MnemoPayService } from "../services/mnemopay-service.ts";

function extractAmount(text: string): number | null {
	const match = text.match(
		/(?:\$|USD\s*)?(\d+(?:\.\d{1,2})?)/i,
	);
	return match ? Number.parseFloat(match[1]) : null;
}

function extractDescription(text: string): string {
	// Remove the amount part and common trigger words to get the description
	return text
		.replace(/(?:charge|pay|payment|escrow|send)\s*/gi, "")
		.replace(/(?:\$|USD\s*)?(\d+(?:\.\d{1,2})?)/i, "")
		.replace(/^\s*(?:for|to|of)\s*/i, "")
		.trim() || "Payment";
}

export const chargePaymentAction: Action = {
	name: "CHARGE_PAYMENT",
	similes: ["PAY", "ESCROW", "CHARGE", "SEND_PAYMENT", "CREATE_PAYMENT"],
	description:
		"Create an escrow payment charge. Deducts the specified amount from the agent's wallet and holds it until settlement or refund. Use when the agent needs to pay for a service or task.",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const service = runtime.getService("mnemopay") as MnemoPayService | null;
		if (!service) {
			return false;
		}
		const text = typeof message.content === "string"
			? message.content
			: message.content?.text ?? "";
		const hasAmount = /\d+(?:\.\d{1,2})?/.test(text);
		const hasTrigger =
			text.toLowerCase().includes("charge") ||
			text.toLowerCase().includes("pay") ||
			text.toLowerCase().includes("escrow");
		return hasAmount && hasTrigger;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		try {
			const service = runtime.getService("mnemopay") as MnemoPayService;
			const engine = service.getEngine();

			const text = typeof message.content === "string"
				? message.content
				: message.content?.text ?? "";

			const amount = extractAmount(text);
			if (!amount || amount <= 0) {
				if (callback) {
					await callback({
						text: "Could not determine a valid payment amount. Please specify an amount (e.g., \"charge $50 for design work\").",
						actions: ["CHARGE_PAYMENT_FAILED"],
						source: message.content.source,
					});
				}
				return {
					success: false,
					text: "Invalid or missing payment amount",
				};
			}

			const description = extractDescription(text);
			const txId = await engine.charge(amount, description);
			const balance = engine.balance();

			logger.info(
				{ src: "action:charge-payment", txId, amount, description },
				"Payment charged",
			);

			if (callback) {
				await callback({
					text: `Payment of $${amount.toFixed(2)} charged for "${description}". Transaction ID: ${txId}. Wallet balance: $${balance.wallet.toFixed(2)}`,
					actions: ["CHARGE_PAYMENT"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: `Payment charged: $${amount.toFixed(2)}`,
				values: {
					transactionId: txId,
					amount: String(amount),
					description,
					walletBalance: String(balance.wallet),
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "action:charge-payment", error: errorMessage },
				"Failed to charge payment",
			);
			return {
				success: false,
				text: `Failed to charge payment: ${errorMessage}`,
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "Charge $50 for the design task" },
			},
			{
				name: "agent",
				content: { text: "Payment of $50.00 charged for \"the design task\". Transaction ID: tx_agent_1_1234567890. Wallet balance: -$50.00" },
			},
		],
		[
			{
				name: "user",
				content: { text: "Pay 100 for code review" },
			},
			{
				name: "agent",
				content: { text: "Payment of $100.00 charged for \"code review\". Transaction ID: tx_agent_2_1234567890. Wallet balance: -$150.00" },
			},
		],
	] as ActionExample[][],
};
