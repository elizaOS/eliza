import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";

export const CHAT_STATE_PROVIDER = "FEISHU_CHAT_STATE";

/**
 * Provider that supplies Feishu chat state information to the agent.
 */
export const chatStateProvider: Provider = {
	name: CHAT_STATE_PROVIDER,
	description: "Provides Feishu chat context and state information",
	descriptionCompressed: "provide Feishu chat context state information",

	dynamic: true,
	contexts: ["messaging", "connectors"],
	contextGate: { anyOf: ["messaging", "connectors"] },
	cacheStable: false,
	cacheScope: "turn",
	get: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		// Only provide state for Feishu messages
		if (message.content?.source !== "feishu") {
			return { text: "" };
		}

		const chatId = message.content?.chatId as string | undefined;
		const messageId = message.content?.messageId as string | undefined;

		if (!chatId) {
			return { text: "" };
		}

		const stateInfo: string[] = [`Platform: Feishu/Lark`, `Chat ID: ${chatId}`];

		if (messageId) {
			stateInfo.push(`Message ID: ${messageId}`);
		}

		// Add any additional state information from the state object
		if (state?.values?.feishuChatType) {
			stateInfo.push(`Chat Type: ${state.values.feishuChatType}`);
		}

		if (state?.values?.feishuChatName) {
			stateInfo.push(`Chat Name: ${state.values.feishuChatName}`);
		}

		return { text: stateInfo.join("\n") };
	},
};
