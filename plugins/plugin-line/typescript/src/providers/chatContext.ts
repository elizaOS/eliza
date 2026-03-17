/**
 * Chat context provider for the LINE plugin.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { LineService } from "../service.js";
import { LINE_SERVICE_NAME, type LineChatType } from "../types.js";

export const chatContextProvider: Provider = {
	name: "lineChatContext",
	description: "Provides information about the current LINE chat context",

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		// Only provide context for LINE messages
		if (message.content.source !== "line") {
			return {
				data: {},
				values: {},
				text: "",
			};
		}

		const lineService = runtime.getService(LINE_SERVICE_NAME) as unknown as
			| LineService
			| undefined;

		if (!lineService || !lineService.isConnected()) {
			return {
				data: { connected: false },
				values: { connected: false },
				text: "",
			};
		}

		const agentName = state?.agentName || "The agent";
		const stateData = (state?.data || {}) as Record<string, unknown>;

		const userId = stateData.userId as string | undefined;
		const groupId = stateData.groupId as string | undefined;
		const roomId = stateData.roomId as string | undefined;

		let chatType: LineChatType = "user";
		let chatId = userId || "";

		if (groupId) {
			chatType = "group";
			chatId = groupId;
		} else if (roomId) {
			chatType = "room";
			chatId = roomId;
		}

		// Get additional info based on chat type
		let chatName = "";
		let memberCount: number | undefined;

		if (chatType === "group" && groupId) {
			const groupInfo = await lineService.getGroupInfo(groupId);
			if (groupInfo) {
				chatName = groupInfo.groupName || "";
				memberCount = groupInfo.memberCount;
			}
		}

		let responseText = `${agentName} is chatting on LINE `;

		if (chatType === "user") {
			responseText += "in a direct message conversation.";
		} else if (chatType === "group") {
			responseText += `in group "${chatName || chatId}".`;
			if (memberCount) {
				responseText += ` The group has ${memberCount} members.`;
			}
		} else if (chatType === "room") {
			responseText += "in a multi-person chat room.";
		}

		responseText +=
			" LINE supports text messages, images, locations, rich cards (flex messages), and quick replies.";

		return {
			data: {
				chatType,
				chatId,
				userId,
				groupId,
				roomId,
				chatName,
				memberCount,
				connected: true,
			},
			values: {
				chatType,
				chatId,
				chatName,
			},
			text: responseText,
		};
	},
};
