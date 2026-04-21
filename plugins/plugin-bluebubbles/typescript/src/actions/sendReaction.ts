/**
 * Send reaction action for the BlueBubbles plugin.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import {
	composePromptFromState,
	logger,
	ModelType,
	parseJSONObjectFromText,
} from "@elizaos/core";
import { BLUEBUBBLES_SERVICE_NAME } from "../constants.js";
import type { BlueBubblesService } from "../service.js";

const SEND_REACTION_TEMPLATE = `# Task: Extract BlueBubbles reaction parameters

Based on the conversation, determine what reaction to add or remove.

Recent conversation:
{{recentMessages}}

Extract the following:
1. emoji: The emoji reaction to add (heart, thumbsup, thumbsdown, haha, exclamation, question, or any emoji)
2. messageId: The message ID to react to (or "last" for the last message)
3. remove: true to remove the reaction, false to add it

Respond with a JSON object:
\`\`\`json
{
  "emoji": "❤️",
  "messageId": "last",
  "remove": false
}
\`\`\`
`;

interface ReactionParams {
	emoji: string;
	messageId: string;
	remove: boolean;
}

export const sendReactionAction: Action = {
	name: "BLUEBUBBLES_SEND_REACTION",
	similes: ["BLUEBUBBLES_REACT", "BB_REACTION", "IMESSAGE_REACT"],
	description: "Add or remove a reaction on a message via BlueBubbles",
	descriptionCompressed: "React on iMessage via BlueBubbles.",
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!message || typeof message.content !== "object" || !message.content) {
			return false;
		}
		return message.content.source === "bluebubbles";
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const bbService = runtime.getService<BlueBubblesService>(
			BLUEBUBBLES_SERVICE_NAME,
		);
		const currentState = state ?? (await runtime.composeState(message));

		if (!bbService?.isConnected()) {
			if (callback) {
				await callback({
					text: "BlueBubbles service is not available.",
					source: "bluebubbles",
				});
			}
			return { success: false, error: "BlueBubbles service not available" };
		}

		// Extract parameters using LLM
		const prompt = await composePromptFromState({
			template: SEND_REACTION_TEMPLATE,
			state: currentState,
		});

		let reactionInfo: ReactionParams | null = null;

		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
			});

			const parsed = parseJSONObjectFromText(response);
			if (parsed?.emoji) {
				reactionInfo = {
					emoji: String(parsed.emoji),
					messageId: String(parsed.messageId || "last"),
					remove: Boolean(parsed.remove),
				};
				break;
			}
		}

		if (!reactionInfo?.emoji) {
			if (callback) {
				await callback({
					text: "I couldn't understand the reaction. Please specify an emoji.",
					source: "bluebubbles",
				});
			}
			return { success: false, error: "Could not extract reaction parameters" };
		}

		// Get chat context
		const stateData = (currentState.data || {}) as Record<string, unknown>;
		const chatGuid = stateData.chatGuid as string;
		let messageGuid = reactionInfo.messageId;

		if (!chatGuid) {
			if (callback) {
				await callback({
					text: "I couldn't determine the chat to react in.",
					source: "bluebubbles",
				});
			}
			return { success: false, error: "Could not determine chat" };
		}

		// If "last", get the last message GUID from context
		if (messageGuid === "last" || !messageGuid) {
			messageGuid = stateData.lastMessageGuid as string;
			if (!messageGuid) {
				if (callback) {
					await callback({
						text: "I couldn't find the message to react to.",
						source: "bluebubbles",
					});
				}
				return { success: false, error: "Could not find message to react to" };
			}
		}

		// Send reaction - we only support adding reactions, not removing
		// The BlueBubbles API handles remove through a negative reaction type internally
		const reactionValue = reactionInfo.remove
			? `-${reactionInfo.emoji}`
			: reactionInfo.emoji;
		const result = await bbService.sendReaction(
			chatGuid,
			messageGuid,
			reactionValue,
		);

		if (!result.success) {
			if (callback) {
				await callback({
					text: `Failed to ${reactionInfo.remove ? "remove" : "add"} reaction.`,
					source: "bluebubbles",
				});
			}
			return { success: false, error: "Failed to send reaction" };
		}

		logger.debug(
			`${reactionInfo.remove ? "Removed" : "Added"} reaction ${reactionInfo.emoji} on ${messageGuid}`,
		);

		if (callback) {
			await callback({
				text: reactionInfo.remove
					? "Reaction removed."
					: `Reacted with ${reactionInfo.emoji}.`,
				source: message.content.source as string,
			});
		}

		return { success: true };
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "React to that message with a heart" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "I'll add a heart reaction.",
					actions: ["BLUEBUBBLES_SEND_REACTION"],
				},
			},
		],
	],
};
