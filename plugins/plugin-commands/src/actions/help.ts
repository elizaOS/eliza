/**
 * Help command action
 */

import type {
	Action,
	ActionExample,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { detectCommand } from "../parser";
import { getEnabledCommands } from "../registry";

/**
 * Format command list for help display
 */
function formatCommandList(
	commands: ReturnType<typeof getEnabledCommands>,
): string {
	const lines: string[] = ["**Available Commands:**\n"];

	const categories = [
		{ key: "status", name: "Status" },
		{ key: "session", name: "Session" },
		{ key: "options", name: "Options" },
		{ key: "management", name: "Management" },
		{ key: "media", name: "Media" },
		{ key: "tools", name: "Tools" },
	];

	for (const cat of categories) {
		const catCommands = commands.filter((c) => c.category === cat.key);
		if (catCommands.length === 0) continue;

		lines.push(`\n**${cat.name}:**`);
		for (const cmd of catCommands) {
			const aliases = cmd.textAliases.slice(0, 2).join(", ");
			lines.push(`• ${aliases} - ${cmd.description}`);
		}
	}

	// Add uncategorized commands
	const uncategorized = commands.filter((c) => !c.category);
	if (uncategorized.length > 0) {
		lines.push("\n**Other:**");
		for (const cmd of uncategorized) {
			const aliases = cmd.textAliases.slice(0, 2).join(", ");
			lines.push(`• ${aliases} - ${cmd.description}`);
		}
	}

	return lines.join("\n");
}

export const helpAction: Action = {
	name: "HELP_COMMAND",
	description:
		"Show available commands and their descriptions. Only activates for /help, /h, or /? slash commands.",
	descriptionCompressed:
		"Show commands and descriptions. Trigger: /help, /h, /?.",
	// Only slash-command similes — "help" or "show help" as natural language
	// should be handled by the LLM's normal response, not this action
	similes: ["/help", "/h", "/?"],
	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		const textRaw = message.content?.text ?? "";
		const text = textRaw.toLowerCase();
		const hasKeyword =
			text.includes("/help") || text.includes("/h") || text.includes("/?");
		const hasRegex = /^(?:\/|!)\s*(?:help|h|\?)(?:\s|$|:)/i.test(textRaw);
		const hasContext = Boolean(
			runtime?.agentId || message?.roomId || message?.content,
		);
		const hasInput = textRaw.trim().length > 0;
		if (!(hasKeyword && hasRegex && hasContext && hasInput)) {
			return false;
		}
		const detection = detectCommand(textRaw);
		return detection.isCommand && detection.command?.key === "help";
	},

	async handler(
		_runtime: IAgentRuntime,
		message: Memory,
		_state,
		_options,
		callback,
	) {
		// Guard: only show help when the user actually asked for it.
		// The runtime doesn't call validate before handler, so the LLM
		// can select HELP_COMMAND during action retry loops even when the
		// user never typed /help.
		const detection = detectCommand(message?.content?.text ?? "");
		if (!detection.isCommand || detection.command?.key !== "help") {
			return { success: false, text: "" };
		}

		const commands = getEnabledCommands();
		const helpText = formatCommandList(commands);

		await callback?.({ text: helpText });

		return {
			success: true,
			text: helpText,
			data: { commandCount: commands.length },
		};
	},

	examples: [
		[
			{ name: "user", content: { text: "/help" } },
			{
				name: "assistant",
				content: {
					text: "**Available Commands:**\n\n**Status:**\n• /help - Show available commands...",
				},
			},
		],
		[
			{ name: "user", content: { text: "/?" } },
			{
				name: "assistant",
				content: {
					text: "**Available Commands:**\n\n**Status:**\n• /help - Show available commands...",
				},
			},
		],
	] as ActionExample[][],
};
