/**
 * Chat state provider for BlueBubbles
 */
import {
	type IAgentRuntime,
	logger,
	type Memory,
	type Provider,
	type ProviderResult,
	type State,
} from "@elizaos/core";
import { BLUEBUBBLES_SERVICE_NAME } from "../constants";
import {
	validateActionKeywords,
	validateActionRegex,
} from "../providerRelevance";
import type { BlueBubblesService } from "../service";
import type { BlueBubblesChatState } from "../types";

export const chatStateProvider: Provider = {
	name: "BLUEBUBBLES_CHAT_STATE",
	description:
		"Provides information about the current BlueBubbles/iMessage chat context",
	descriptionCompressed: "BlueBubbles/iMessage chat state.",

	dynamic: true,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const __providerKeywords = [
			"bluebubbles",
			"chat",
			"state",
			"chatstateprovider",
			"plugin",
			"status",
			"context",
			"info",
			"details",
			"conversation",
			"agent",
			"room",
			"channel",
			"user",
		];
		const __providerRegex = new RegExp(
			`\\b(${__providerKeywords.join("|")})\\b`,
			"i",
		);
		const __recentMessages = _state?.recentMessagesData || [];
		const __isRelevant =
			validateActionKeywords(message, __recentMessages, __providerKeywords) ||
			validateActionRegex(message, __recentMessages, __providerRegex);
		if (!__isRelevant) {
			return { text: "" };
		}

		const service = runtime.getService<BlueBubblesService>(
			BLUEBUBBLES_SERVICE_NAME,
		);

		if (!service?.getIsRunning()) {
			return { text: "" };
		}

		try {
			const room = await runtime.getRoom(message.roomId);
			if (!room?.channelId) {
				return { text: "" };
			}

			// Only provide state for BlueBubbles channels
			if (room.source !== "bluebubbles") {
				return { text: "" };
			}

			const chatState = await service.getChatState(room.channelId);
			if (!chatState) {
				return { text: "" };
			}

			return { text: formatChatState(chatState) };
		} catch (error) {
			logger.debug(
				`Failed to get BlueBubbles chat state: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { text: "" };
		}
	},
};

/**
 * Formats the chat state for inclusion in prompts
 */
function formatChatState(state: BlueBubblesChatState): string {
	const lines: string[] = [
		"# iMessage Chat Context (BlueBubbles)",
		"",
		`- Chat Type: ${state.isGroup ? "Group Chat" : "Direct Message"}`,
	];

	if (state.displayName) {
		lines.push(`- Chat Name: ${state.displayName}`);
	}

	if (state.isGroup) {
		lines.push(`- Participants: ${state.participants.join(", ")}`);
	} else {
		lines.push(`- Contact: ${state.participants[0] ?? state.chatIdentifier}`);
	}

	if (state.lastMessageAt) {
		const lastMessageDate = new Date(state.lastMessageAt);
		lines.push(`- Last Message: ${lastMessageDate.toLocaleString()}`);
	}

	if (state.hasUnread) {
		lines.push("- Has Unread Messages: Yes");
	}

	lines.push("");
	lines.push(
		"Note: This conversation is happening through iMessage. Be conversational and friendly.",
	);

	return lines.join("\n");
}
