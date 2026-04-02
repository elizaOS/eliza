/**
 * RECALL_MEMORIES Action
 *
 * Queries the agent's economic memory for past payment outcomes,
 * provider assessments, and financial interaction history.
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

export const recallMemoriesAction: Action = {
	name: "RECALL_MEMORIES",
	similes: [
		"SEARCH_MEMORIES",
		"QUERY_MEMORIES",
		"FIND_OUTCOMES",
		"LOOKUP_HISTORY",
		"CHECK_HISTORY",
	],
	description:
		"Query the agent's economic memory for past payment outcomes, provider quality assessments, and financial interaction history. Use when the agent needs to recall past experiences to inform a decision.",

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
			text.toLowerCase().includes("recall") ||
			text.toLowerCase().includes("remember") ||
			text.toLowerCase().includes("what do you know about") ||
			text.toLowerCase().includes("past experience") ||
			text.toLowerCase().includes("history with")
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

			// Extract query — remove trigger words to get the search term
			const query = text
				.replace(
					/(?:recall|remember|what do you know about|past experience|history with|search|query|find|lookup|check)\s*/gi,
					"",
				)
				.trim() || text;

			const limit = (message.metadata?.limit as number) ?? 5;
			const memories = await engine.recall(query, limit);

			logger.info(
				{ src: "action:recall-memories", query, count: memories.length },
				"Economic memories recalled",
			);

			if (memories.length === 0) {
				if (callback) {
					await callback({
						text: `No economic memories found for "${query}". I have no prior experience with this topic.`,
						actions: ["RECALL_MEMORIES"],
						source: message.content.source,
					});
				}
				return {
					success: true,
					text: "No memories found",
					values: { query, count: "0" },
				};
			}

			const formatted = memories
				.map(
					(m, i) =>
						`${i + 1}. [${m.importance.toFixed(1)} importance] ${m.content} (tags: ${m.tags.join(", ")})`,
				)
				.join("\n");

			if (callback) {
				await callback({
					text: `Found ${memories.length} economic memories for "${query}":\n${formatted}`,
					actions: ["RECALL_MEMORIES"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: `Recalled ${memories.length} memories`,
				values: {
					query,
					count: String(memories.length),
					memories: formatted,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "action:recall-memories", error: errorMessage },
				"Failed to recall memories",
			);
			return {
				success: false,
				text: `Failed to recall memories: ${errorMessage}`,
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "What do you know about Provider X?" },
			},
			{
				name: "agent",
				content: { text: "Found 2 economic memories for \"Provider X\":\n1. [0.8 importance] Provider X delivered high quality work on time (tags: provider)\n2. [0.6 importance] Provider X charged $200 for logo design (tags: provider, design)" },
			},
		],
		[
			{
				name: "user",
				content: { text: "Recall past payment experiences" },
			},
			{
				name: "agent",
				content: { text: "Found 3 economic memories for \"payment experiences\":\n1. [0.9 importance] Settlement with vendor ABC was smooth (tags: payment, positive)\n2. [0.7 importance] Had to refund vendor DEF for late delivery (tags: payment, negative)\n3. [0.5 importance] Standard payment to freelancer GHI (tags: payment)" },
			},
		],
	] as ActionExample[][],
};
