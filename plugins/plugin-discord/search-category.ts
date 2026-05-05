import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";

export const DISCORD_MESSAGES_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "discord_messages",
	label: "Discord messages",
	description:
		"Search Discord channel messages by query, channel, author, and time range.",
	contexts: ["social"],
	filters: [
		{ name: "query", label: "Query", type: "string", required: true },
		{
			name: "channelIdentifier",
			label: "Channel",
			description:
				"Channel id, channel name, or current for the current Discord channel.",
			type: "string",
			default: "current",
		},
		{
			name: "author",
			label: "Author",
			description: "Discord username or display name to filter by.",
			type: "string",
		},
		{
			name: "timeRange",
			label: "Time range",
			description: "Recent message window to search.",
			type: "enum",
			options: [
				{ label: "Hour", value: "hour" },
				{ label: "Day", value: "day" },
				{ label: "Week", value: "week" },
				{ label: "Month", value: "month" },
			],
		},
		{
			name: "limit",
			label: "Limit",
			description: "Maximum messages to return, from 1 to 100.",
			type: "number",
			default: 20,
		},
	],
	resultSchemaSummary:
		"Discord Message[] with author, createdTimestamp, content preview, attachments, url, channel id, and channel name.",
	capabilities: ["messages", "channels", "authors", "time-range"],
	source: "plugin:discord",
	serviceType: "discord",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
	try {
		runtime.getSearchCategory(category, { includeDisabled: true });
		return true;
	} catch {
		return false;
	}
}

export function registerDiscordSearchCategory(runtime: IAgentRuntime): void {
	if (!hasSearchCategory(runtime, DISCORD_MESSAGES_SEARCH_CATEGORY.category)) {
		runtime.registerSearchCategory(DISCORD_MESSAGES_SEARCH_CATEGORY);
	}
}
