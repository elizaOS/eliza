/**
 * MnemoPay Provider
 *
 * Injects the agent's economic memory context, wallet balance, and reputation
 * into every conversation. This gives the LLM awareness of the agent's
 * financial state and past payment experiences.
 */

import { logger } from "../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";
import type { MnemoPayService } from "../services/mnemopay-service.ts";

export const mnemoPayProvider: Provider = {
	name: "MNEMOPAY_CONTEXT",
	description:
		"Economic memory context — wallet balance, reputation score, recent transactions, and relevant payment memories",
	position: 45,

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const service = runtime.getService(
				"mnemopay",
			) as MnemoPayService | null;

			if (!service) {
				return {
					data: { available: false },
					values: { mnemoPayContext: "" },
					text: "",
				};
			}

			const engine = service.getEngine();
			const balance = engine.balance();
			const recentTxs = engine.getRecentTransactions(5);

			// Recall memories relevant to the current message
			const messageText = typeof message.content === "string"
				? message.content
				: message.content?.text ?? "";

			let relevantMemories: string[] = [];
			if (messageText.length > 0) {
				try {
					const memories = await engine.recall(messageText, 3);
					relevantMemories = memories.map(
						(m) =>
							`- [${m.importance.toFixed(1)}] ${m.content} (${m.tags.join(", ")})`,
					);
				} catch {
					// Non-critical — skip memory recall if it fails
				}
			}

			// Build context sections
			const sections: string[] = [];

			sections.push(
				`Wallet: $${balance.wallet.toFixed(2)} | Reputation: ${balance.reputation.toFixed(2)}/2.00`,
			);

			if (recentTxs.length > 0) {
				const txLines = recentTxs.map(
					(tx) =>
						`- ${tx.id}: $${tx.amount.toFixed(2)} — ${tx.description} [${tx.status}]`,
				);
				sections.push(`Recent transactions:\n${txLines.join("\n")}`);
			}

			if (relevantMemories.length > 0) {
				sections.push(
					`Relevant economic memories:\n${relevantMemories.join("\n")}`,
				);
			}

			const contextText = sections.join("\n\n");
			const text = addHeader("# Economic Memory (MnemoPay)", contextText);

			return {
				data: {
					walletBalance: balance.wallet,
					reputation: balance.reputation,
					recentTransactionCount: recentTxs.length,
					relevantMemoryCount: relevantMemories.length,
				},
				values: {
					mnemoPayContext: contextText,
					walletBalance: String(balance.wallet),
					reputation: String(balance.reputation),
				},
				text,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "provider:mnemopay", error: errorMessage },
				"Failed to build economic memory context",
			);
			return {
				data: { available: false, error: errorMessage },
				values: { mnemoPayContext: "" },
				text: "",
			};
		}
	},
};
