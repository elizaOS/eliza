/**
 * SETTLE_PAYMENT Action
 *
 * Settles a pending payment transaction, confirming the work/service was
 * satisfactory. Reinforces the agent's reputation (+reputationDelta).
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

function extractTransactionId(text: string): string | null {
	const match = text.match(/tx_[a-zA-Z0-9_]+/);
	return match ? match[0] : null;
}

export const settlePaymentAction: Action = {
	name: "SETTLE_PAYMENT",
	similes: [
		"CONFIRM_PAYMENT",
		"COMPLETE_PAYMENT",
		"FINALIZE_PAYMENT",
		"APPROVE_PAYMENT",
	],
	description:
		"Settle a pending payment transaction, confirming satisfactory delivery. This reinforces the agent's reputation. Use when the agent confirms a service or task was completed successfully.",

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
			text.toLowerCase().includes("settle") ||
			text.toLowerCase().includes("confirm") ||
			text.toLowerCase().includes("finalize") ||
			text.toLowerCase().includes("approve payment")
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

			const txId = extractTransactionId(text);
			if (!txId) {
				// Try to settle the most recent pending transaction
				const recent = engine.getRecentTransactions(10);
				const pending = recent.find((t) => t.status === "pending");
				if (!pending) {
					if (callback) {
						await callback({
							text: "No pending transaction found to settle. Please provide a transaction ID (e.g., \"settle tx_agent_1_123\").",
							actions: ["SETTLE_PAYMENT_FAILED"],
							source: message.content.source,
						});
					}
					return {
						success: false,
						text: "No pending transaction found",
					};
				}
				const settled = await engine.settle(pending.id);
				const balance = engine.balance();

				logger.info(
					{ src: "action:settle-payment", txId: pending.id },
					"Payment settled (latest pending)",
				);

				if (callback) {
					await callback({
						text: `Payment settled: $${settled.amount.toFixed(2)} for "${settled.description}". Reputation: ${balance.reputation.toFixed(2)}`,
						actions: ["SETTLE_PAYMENT"],
						source: message.content.source,
					});
				}

				return {
					success: true,
					text: `Payment ${pending.id} settled`,
					values: {
						transactionId: pending.id,
						amount: String(settled.amount),
						reputation: String(balance.reputation),
					},
				};
			}

			const settled = await engine.settle(txId);
			const balance = engine.balance();

			logger.info(
				{ src: "action:settle-payment", txId },
				"Payment settled",
			);

			if (callback) {
				await callback({
					text: `Payment settled: $${settled.amount.toFixed(2)} for "${settled.description}". Reputation: ${balance.reputation.toFixed(2)}`,
					actions: ["SETTLE_PAYMENT"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: `Payment ${txId} settled`,
				values: {
					transactionId: txId,
					amount: String(settled.amount),
					reputation: String(balance.reputation),
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "action:settle-payment", error: errorMessage },
				"Failed to settle payment",
			);

			if (callback) {
				await callback({
					text: `Failed to settle payment: ${errorMessage}`,
					actions: ["SETTLE_PAYMENT_FAILED"],
					source: message.content.source,
				});
			}

			return {
				success: false,
				text: `Failed to settle payment: ${errorMessage}`,
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "Settle payment tx_agent_1_1234567890" },
			},
			{
				name: "agent",
				content: { text: "Payment settled: $50.00 for \"design task\". Reputation: 1.05" },
			},
		],
		[
			{
				name: "user",
				content: { text: "Confirm the last payment, work was good" },
			},
			{
				name: "agent",
				content: { text: "Payment settled: $100.00 for \"code review\". Reputation: 1.10" },
			},
		],
	] as ActionExample[][],
};
