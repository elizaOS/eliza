/**
 * REMEMBER_OUTCOME Action
 *
 * Stores a payment or interaction outcome in the agent's economic memory.
 * The agent learns from each financial interaction to make better future decisions.
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

export const rememberOutcomeAction: Action = {
	name: "REMEMBER_OUTCOME",
	similes: [
		"STORE_OUTCOME",
		"SAVE_MEMORY",
		"LOG_OUTCOME",
		"RECORD_INTERACTION",
	],
	description:
		"Store a payment or interaction outcome in economic memory. Use when the agent needs to remember a financial event, provider quality, or transaction result for future reference.",

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
			text.toLowerCase().includes("remember") ||
			text.toLowerCase().includes("outcome") ||
			text.toLowerCase().includes("store") ||
			text.toLowerCase().includes("record")
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

			// Extract importance from message metadata or default to 0.5
			const importance =
				(message.metadata?.importance as number) ?? 0.5;
			const tags =
				(message.metadata?.tags as string[]) ?? ["interaction"];

			const entry = await engine.remember(text, { importance, tags });

			logger.info(
				{ src: "action:remember-outcome", entry },
				"Outcome stored in economic memory",
			);

			if (callback) {
				await callback({
					text: `Stored in economic memory: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}" (importance: ${importance})`,
					actions: ["REMEMBER_OUTCOME"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: "Outcome stored in economic memory",
				values: {
					importance: String(entry.importance),
					tags: entry.tags.join(", "),
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "action:remember-outcome", error: errorMessage },
				"Failed to store outcome",
			);
			return {
				success: false,
				text: `Failed to store outcome: ${errorMessage}`,
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "Remember that Provider X delivered high quality work on time" },
			},
			{
				name: "agent",
				content: { text: "Stored in economic memory: \"Provider X delivered high quality work on time\" (importance: 0.8)" },
			},
		],
		[
			{
				name: "user",
				content: { text: "Record that the last payment to vendor ABC was disputed" },
			},
			{
				name: "agent",
				content: { text: "Stored in economic memory: \"The last payment to vendor ABC was disputed\" (importance: 0.5)" },
			},
		],
	] as ActionExample[][],
};
