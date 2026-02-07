/**
 * Help command action
 */

import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { getCommandsByCategory, getEnabledCommands } from "../registry";
import { detectCommand } from "../parser";

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
  // Only slash-command similes — "help" or "show help" as natural language
  // should be handled by the LLM's normal response, not this action
  similes: ["/help", "/h", "/?"],

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content?.text ?? "";
    // Strict: only activate for slash commands, never natural language
    const detection = detectCommand(text);
    return detection.isCommand && detection.command?.key === "help";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ) {
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
      { user: "user", content: { text: "/help" } },
      {
        user: "assistant",
        content: {
          text: "**Available Commands:**\n\n**Status:**\n• /help - Show available commands...",
        },
      },
    ],
    [
      { user: "user", content: { text: "/?" } },
      {
        user: "assistant",
        content: {
          text: "**Available Commands:**\n\n**Status:**\n• /help - Show available commands...",
        },
      },
    ],
  ] as ActionExample[][],
};
