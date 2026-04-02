/**
 * REFUND_PAYMENT Action
 *
 * Refunds a payment transaction and docks the agent's reputation.
 * Used when a service or task delivery was unsatisfactory.
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
import { extractTransactionId } from "./utils.ts";

export const refundPaymentAction: Action = {
	name: "REFUND_PAYMENT",
	similes: [
		"REVERSE_PAYMENT",
		"CANCEL_PAYMENT",
		"DISPUTE_PAYMENT",
		"CHARGEBACK",
	],
	description:
		"Refund a payment transaction and dock the agent's reputation. Use when a service or task was unsatisfactory and the payment should be reversed.",

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
		return (
			text.toLowerCase().includes("refund") ||
			text.toLowerCase().includes("reverse") ||
			text.toLowerCase().includes("chargeback") ||
			text.toLowerCase().includes("dispute")
		);
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

			let txId = extractTransactionId(text);

			if (!txId) {
				// Try to refund the most recent refundable transaction
				const recent = engine.getRecentTransactions(10);
				const refundable = recent.find(
					(t) => t.status === "pending" || t.status === "settled",
				);
				if (!refundable) {
					if (callback) {
						await callback({
							text: "No refundable transaction found. Please provide a transaction ID (e.g., \"refund tx_agent_1_123\").",
							actions: ["REFUND_PAYMENT_FAILED"],
							source: message.content.source,
						});
					}
					return {
						success: false,
						text: "No refundable transaction found",
					};
				}
				txId = refundable.id;
			}

			const refunded = await engine.refund(txId);
			const balance = engine.balance();

			logger.info(
				{ src: "action:refund-payment", txId },
				"Payment refunded",
			);

			if (callback) {
				await callback({
					text: `Payment refunded: $${refunded.amount.toFixed(2)} for "${refunded.description}". Wallet: $${balance.wallet.toFixed(2)}, Reputation: ${balance.reputation.toFixed(2)}`,
					actions: ["REFUND_PAYMENT"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: `Payment ${txId} refunded`,
				values: {
					transactionId: txId,
					amount: String(refunded.amount),
					walletBalance: String(balance.wallet),
					reputation: String(balance.reputation),
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "action:refund-payment", error: errorMessage },
				"Failed to refund payment",
			);

			if (callback) {
				await callback({
					text: `Failed to refund payment: ${errorMessage}`,
					actions: ["REFUND_PAYMENT_FAILED"],
					source: message.content.source,
				});
			}

			return {
				success: false,
				text: `Failed to refund payment: ${errorMessage}`,
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "Refund payment tx_agent_1_1234567890, the work was subpar" },
			},
			{
				name: "agent",
				content: { text: "Payment refunded: $50.00 for \"design task\". Wallet: $0.00, Reputation: 0.95" },
			},
		],
		[
			{
				name: "user",
				content: { text: "Dispute the last payment, service was not delivered" },
			},
			{
				name: "agent",
				content: { text: "Payment refunded: $100.00 for \"code review\". Wallet: $100.00, Reputation: 0.90" },
			},
		],
	] as ActionExample[][],
};
