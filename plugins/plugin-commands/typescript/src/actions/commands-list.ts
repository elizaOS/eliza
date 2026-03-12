/**
 * Commands list action
 */

import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { getEnabledCommands } from "../registry";
import { detectCommand } from "../parser";

export const commandsListAction: Action = {
  name: "COMMANDS_LIST",
  description:
    "List all available commands with their aliases. Only activates for /commands or /cmds slash commands.",
  // Only slash-command similes to avoid matching natural language
  similes: ["/commands", "/cmds"],

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content?.text ?? "";
    // Strict: only activate for slash commands, never natural language
    const detection = detectCommand(text);
    return detection.isCommand && detection.command?.key === "commands";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
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
