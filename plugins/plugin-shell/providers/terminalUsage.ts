import {
	type IAgentRuntime,
	type Memory,
	type Provider,
	type ProviderResult,
	type State,
	validateActionKeywords,
	validateActionRegex,
} from "@elizaos/core";

export const terminalUsageProvider: Provider = {
	name: "terminalUsage",
	description: "Terminal usage instructions",
	descriptionCompressed: "Terminal usage instructions.",
	dynamic: true,
	relevanceKeywords: [
		"terminalusage",
		"terminalusageprovider",
		"plugin",
		"shell",
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
	],
	get: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const __providerKeywords = [
			"terminalusage",
			"terminalusageprovider",
			"plugin",
			"shell",
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
		const __recentMessages = (_state?.recentMessagesData || []) as Memory[];
		const __isRelevant =
			validateActionKeywords(_message, __recentMessages, __providerKeywords) ||
			validateActionRegex(_message, __recentMessages, __providerRegex);
		if (!__isRelevant) {
			return { text: "" };
		}

		// Skip terminal docs for agents that don't need shell access.
		// Set character.settings.DISABLE_TERMINAL = true to save ~100 tokens.
		const settings = _runtime.character?.settings;
		if (settings?.DISABLE_TERMINAL) {
			return { text: "" };
		}

		return {
			text: [
				"## Terminal",
				"",
				"You can run shell commands in the user's embedded terminal using the SHELL_COMMAND action.",
				"Use this when the user asks you to run a command, execute a script, install packages, etc.",
				"The terminal auto-opens and shows the command output in real time.",
			].join("\n"),
		};
	},
};
