/**
 * Chat context provider for the BlueBubbles plugin.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import { BLUEBUBBLES_SERVICE_NAME } from "../constants.js";
import {
	validateActionKeywords,
	validateActionRegex,
} from "../providerRelevance.js";
import type { BlueBubblesService } from "../service.js";

/**
 * Extract handle from a chat GUID
 */
function extractHandleFromChatGuid(chatGuid: string): string | null {
	if (!chatGuid) return null;
	// Format: iMessage;-;+1234567890 or iMessage;+;group_id
	const parts = chatGuid.split(";");
	if (parts.length >= 3 && parts[1] === "-") {
		return parts[2];
	}
	return null;
}

export const chatContextProvider: Provider = {
	name: "bluebubblesChatContext",
	description:
		"Provides information about the current BlueBubbles/iMessage chat context",
	descriptionCompressed: "Current BlueBubbles/iMessage chat context.",

	dynamic: true,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		const __providerKeywords = [
			"bluebubbleschatcontext",
			"chatcontextprovider",
			"plugin",
			"bluebubbles",
			"status",
			"state",
			"context",
			"info",
			"details",
			"chat",
			"conversation",
			"agent",
			"room",
			"channel",
		];
		const __providerRegex = new RegExp(
			`\\b(${__providerKeywords.join("|")})\\b`,
			"i",
		);
		const __recentMessages = state?.recentMessagesData || [];
		const __isRelevant =
			validateActionKeywords(message, __recentMessages, __providerKeywords) ||
			validateActionRegex(message, __recentMessages, __providerRegex);
		if (!__isRelevant) {
			return { text: "" };
		}

		// Only provide context for BlueBubbles messages
		if (message.content.source !== "bluebubbles") {
			return { text: "" };
		}

		const bbService = runtime.getService<BlueBubblesService>(
			BLUEBUBBLES_SERVICE_NAME,
		);

		if (!bbService?.isConnected()) {
			return {
				values: { connected: false },
				text: "",
			};
		}

		const agentName = state.values?.agentName?.toString() || "The agent";
		const stateData = (state.data || {}) as Record<string, unknown>;

		const chatGuid = stateData.chatGuid as string | undefined;
		const handle = stateData.handle as string | undefined;
		const displayName = stateData.displayName as string | undefined;

		// Determine chat type from GUID
		let chatType = "direct";
		let chatDescription = "";

		if (chatGuid) {
			if (chatGuid.includes(";+;")) {
				chatType = "group";
				chatDescription = displayName
					? `group chat "${displayName}"`
					: "a group chat";
			} else {
				const extractedHandle = extractHandleFromChatGuid(chatGuid);
				chatDescription = extractedHandle
					? `direct message with ${extractedHandle}`
					: handle
						? `direct message with ${handle}`
						: "a direct message";
			}
		} else if (handle) {
			chatDescription = `direct message with ${handle}`;
		} else {
			chatDescription = "an iMessage conversation";
		}

		const responseText =
			`${agentName} is chatting via iMessage (BlueBubbles) in ${chatDescription}. ` +
			"This channel supports reactions, effects (slam, balloons, confetti, etc.), editing, and replying to messages.";

		return {
			values: {
				chatGuid,
				handle,
				displayName,
				chatType,
				connected: true,
				platform: "bluebubbles",
				supportsReactions: true,
				supportsEffects: true,
				supportsEdit: true,
				supportsReply: true,
			},
			text: responseText,
		};
	},
};
