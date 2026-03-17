/**
 * User context provider for the LINE plugin.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { LineService } from "../service.js";
import { LINE_SERVICE_NAME } from "../types.js";

export const userContextProvider: Provider = {
	name: "lineUserContext",
	description:
		"Provides information about the LINE user in the current conversation",

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

		if (!userId) {
			return {
				data: { connected: true },
				values: { connected: true },
				text: "",
			};
		}

		// Get user profile
		const profile = await lineService.getUserProfile(userId);

		if (!profile) {
			return {
				data: {
					connected: true,
					userId,
				},
				values: {
					userId,
				},
				text: `${agentName} is talking to a LINE user (ID: ${userId.slice(0, 8)}...).`,
			};
		}

		const responseText =
			`${agentName} is talking to ${profile.displayName} on LINE. ` +
			(profile.statusMessage
				? `Their status: "${profile.statusMessage}". `
				: "") +
			(profile.language ? `Language preference: ${profile.language}.` : "");

		return {
			data: {
				userId: profile.userId,
				displayName: profile.displayName,
				pictureUrl: profile.pictureUrl,
				statusMessage: profile.statusMessage,
				language: profile.language,
				connected: true,
			},
			values: {
				userId: profile.userId,
				displayName: profile.displayName,
				language: profile.language,
			},
			text: responseText,
		};
	},
};
