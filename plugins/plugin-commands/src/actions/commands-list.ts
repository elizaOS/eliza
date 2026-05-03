/**
 * Commands list action
 */

import type {
	Action,
	ActionExample,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { detectCommand } from "../parser";
import { getEnabledCommands } from "../registry";

export const commandsListAction: Action = {
	name: "COMMANDS_LIST",
	description:
		"List all available commands with their aliases. Only activates for /commands or /cmds slash commands.",
	descriptionCompressed: "List available commands. Trigger: /commands, /cmds.",
	// Only slash-command similes to avoid matching natural language
	similes: ["/commands", "/cmds"],
	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		const textRaw = message.content?.text ?? "";
		const text = textRaw.toLowerCase();
		const hasKeyword =
			text.includes("/commands") ||
			text.includes("/cmds") ||
			text.includes("commands");
		const hasRegex = /^(?:\/|!)\s*(?:commands|cmds)\b/i.test(textRaw);
		const hasContext = Boolean(
			runtime?.agentId || message?.roomId || message?.content,
		);
		const hasInput = textRaw.trim().length > 0;
		if (!(hasKeyword && hasRegex && hasContext && hasInput)) {
			return false;
		}
		const detection = detectCommand(textRaw);
		return detection.isCommand && detection.command?.key === "commands";
	},

	async handler(
		_runtime: IAgentRuntime,
		_message: Memory,
		_state,
		_options,
		callback,
	) {
		const commands = getEnabledCommands();
		const lines: string[] = [`**Commands (${commands.length}):**\n`];

		for (const cmd of commands) {
			const aliases = cmd.textAliases.join(", ");
			const authNote = cmd.requiresAuth ? " [auth]" : "";
			const elevatedNote = cmd.requiresElevated ? " [elevated]" : "";
			lines.push(`• **${cmd.key}**: ${aliases}${authNote}${elevatedNote}`);
		}

		const replyText = lines.join("\n");
		await callback?.({ text: replyText });

		return {
			success: true,
			text: replyText,
			data: { commandCount: commands.length },
		};
	},

	examples: [
		[
			{ name: "user", content: { text: "/commands" } },
			{
				name: "assistant",
				content: {
					text: "**Commands (15):**\n\n• **help**: /help, /h, /?\n• **status**: /status, /s...",
				},
			},
		],
	] as ActionExample[][],
};
