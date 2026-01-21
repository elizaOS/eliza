/**
 * Discord Event Handlers
 *
 * Custom handlers for Discord-specific events like slash commands,
 * reactions, and member events.
 */

import type { AgentRuntime, EventPayload, Service } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { GuildMember, Interaction, Message } from "discord.js";

// Type definitions for Discord events
interface DiscordSlashCommandPayload extends EventPayload {
  interaction: Interaction;
}

interface DiscordReactionPayload extends EventPayload {
  reaction: { emoji: { name: string }; message: Message };
  user: { id: string; username: string };
}

interface DiscordMemberPayload extends EventPayload {
  member: GuildMember;
}

interface DiscordSlashCommand {
  name: string;
  description: string;
}

interface DiscordServiceLike extends Service {
  client: { isReady(): boolean } | null;
  clientReadyPromise: Promise<void> | null;
}

/**
 * Register all Discord event handlers
 */
export function registerDiscordHandlers(runtime: AgentRuntime): void {
  // Handle slash commands
  runtime.registerEvent<DiscordSlashCommandPayload>(
    "DISCORD_SLASH_COMMAND",
    async ({ interaction }) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      logger.info(`Slash command received: /${interaction.commandName}`);

      switch (interaction.commandName) {
        case "ping":
          await interaction.reply({
            content: "🏓 Pong! I'm alive and responding.",
            ephemeral: true,
          });
          break;

        case "about":
          await interaction.reply({
            content: `👋 Hi! I'm **DiscordEliza**, an AI assistant powered by elizaOS.
            
I use:
• \`@elizaos/plugin-discord\` for Discord integration
• \`@elizaos/plugin-openai\` for language understanding
• \`@elizaos/plugin-sql\` for memory persistence

Mention me or reply to my messages to chat!`,
            ephemeral: true,
          });
          break;

        case "help":
          await interaction.reply({
            content: `**Available Commands:**
• \`/ping\` - Check if I'm online
• \`/about\` - Learn about me
• \`/help\` - Show this help message
• \`/clear\` - Clear conversation context (coming soon)

You can also just @mention me in any channel to chat!`,
            ephemeral: true,
          });
          break;

        default:
          await interaction.reply({
            content: `Unknown command: \`/${interaction.commandName}\``,
            ephemeral: true,
          });
      }
    },
  );

  // Handle reactions (for future use)
  runtime.registerEvent<DiscordReactionPayload>(
    "DISCORD_REACTION_ADDED",
    async ({ reaction, user }) => {
      logger.debug(`Reaction ${reaction.emoji.name} added by ${user.username}`);
      // Custom reaction handling can be implemented here
    },
  );

  // Handle new members (for future use)
  runtime.registerEvent<DiscordMemberPayload>(
    "DISCORD_MEMBER_JOINED",
    async ({ member }) => {
      logger.info(`New member joined: ${member.user.username}`);
      // Welcome message logic can be implemented here
    },
  );

  logger.info("Discord event handlers registered");
}

/**
 * Register slash commands with Discord
 */
export async function registerSlashCommands(
  runtime: AgentRuntime,
): Promise<void> {
  const commands: DiscordSlashCommand[] = [
    { name: "ping", description: "Check if the bot is online" },
    { name: "about", description: "Learn about this bot" },
    { name: "help", description: "Show available commands" },
  ];

  const discordService = runtime.getService<DiscordServiceLike>("discord");

  if (!discordService?.clientReadyPromise) {
    logger.warn(
      "Discord service not ready. Slash commands won't be registered until connected.",
    );
    return;
  }

  await discordService.clientReadyPromise;
  await runtime.emitEvent("DISCORD_REGISTER_COMMANDS", { commands });
  logger.info(`Registered ${commands.length} slash commands`);
}

export default { registerDiscordHandlers, registerSlashCommands };
