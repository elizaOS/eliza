import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { User } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
// Import generated prompts
import { sendDmTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

/**
 * Get DM information from the user's request
 * @param {IAgentRuntime} runtime - The runtime object to interact with the agent.
 * @param {Memory} _message - The memory object containing the input message.
 * @param {State} state - The state of the conversation.
 * @returns {Promise<{recipientIdentifier: string, messageContent: string} | null>} DM info or null if not parseable.
 */
const getDMInfo = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{ recipientIdentifier: string; messageContent: string } | null> => {
  const prompt = composePromptFromState({
    state,
    template: sendDmTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      recipientIdentifier: string;
      messageContent: string;
    } | null;

    if (parsedResponse?.recipientIdentifier && parsedResponse.messageContent) {
      return parsedResponse;
    }
  }
  return null;
};

/**
 * Find a Discord user by various identifiers
 * @param {DiscordService} discordService - The Discord service instance
 * @param {string} identifier - The user identifier (username, ID, or mention)
 * @param {string} currentServerId - The current server ID to search in
 * @returns {Promise<User | null>} The found user or null
 */
const findUser = async (
  discordService: DiscordService,
  identifier: string,
  currentServerId?: string
): Promise<User | null> => {
  if (!discordService.client) {
    return null;
  }

  // Remove mention formatting if present
  const cleanId = identifier.replace(/[<@!>]/g, "");

  try {
    // Try to fetch by ID first
    if (/^\d+$/.test(cleanId)) {
      try {
        return await discordService.client.users.fetch(cleanId);
      } catch (_e) {
        // ID not found, continue to username search
      }
    }

    // Search in the current server if available
    if (currentServerId) {
      const guild = await discordService.client.guilds.fetch(currentServerId);
      const members = await guild.members.fetch();

      // Search by username or display name
      const member = members.find(
        (m) =>
          m.user.username.toLowerCase() === identifier.toLowerCase() ||
          m.displayName.toLowerCase() === identifier.toLowerCase() ||
          m.user.tag.toLowerCase() === identifier.toLowerCase()
      );

      if (member) {
        return member.user;
      }
    }

    // Search in all guilds the bot is in
    const guilds = Array.from(discordService.client.guilds.cache.values());
    for (const guild of guilds) {
      try {
        const members = await guild.members.fetch();
        const member = members.find(
          (m) =>
            m.user.username.toLowerCase() === identifier.toLowerCase() ||
            m.displayName.toLowerCase() === identifier.toLowerCase() ||
            m.user.tag.toLowerCase() === identifier.toLowerCase()
        );

        if (member) {
          return member.user;
        }
      } catch (_e) {
        // Continue searching in other guilds
      }
    }

    return null;
  } catch (_error) {
    // Standalone function - error handled by caller
    return null;
  }
};

const spec = requireActionSpec("SEND_DM");

export const sendDM: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "discord";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const discordService = runtime.getService(DISCORD_SERVICE_NAME) as DiscordService;

    if (!discordService || !discordService.client) {
      runtime.logger.error(
        { src: "plugin:discord:action:send-dm", agentId: runtime.agentId },
        "Discord service not found or not initialized"
      );
      return { success: false, error: "Discord service is not available" };
    }

    if (!state) {
      if (callback) {
        await callback?.({
          text: "State is not available.",
          source: "discord",
        });
      }
      return { success: false, error: "State is not available" };
    }

    const dmInfo = await getDMInfo(runtime, message, state);
    if (!dmInfo) {
      runtime.logger.warn(
        { src: "plugin:discord:action:send-dm", agentId: runtime.agentId },
        "Could not parse DM information from message"
      );
      if (callback) {
        await callback?.({
          text: "I couldn't understand who you want me to message or what to send. Please specify the recipient and the message content.",
          source: "discord",
        });
      }
      return { success: false, error: "Could not parse DM information" };
    }

    try {
      const room = state.data?.room || (await runtime.getRoom(message.roomId));
      const currentServerId = room?.messageServerId;

      // Find the user
      const targetUser = await findUser(
        discordService,
        dmInfo.recipientIdentifier,
        currentServerId
      );

      if (!targetUser) {
        if (callback) {
          await callback?.({
            text: `I couldn't find a user with the identifier "${dmInfo.recipientIdentifier}". Please make sure the username or ID is correct.`,
            source: "discord",
          });
        }
        return { success: false, error: `User not found: ${dmInfo.recipientIdentifier}` };
      }

      // Check if we can send DMs to this user
      if (targetUser.bot) {
        if (callback) {
          await callback?.({
            text: "I cannot send direct messages to other bots.",
            source: "discord",
          });
        }
        return { success: false, error: "Cannot send DMs to bots" };
      }

      // Create or get DM channel
      const dmChannel = await targetUser.createDM();

      // Send the message
      await dmChannel.send(dmInfo.messageContent);

      const response: Content = {
        text: `I've sent your message to ${targetUser.username}: "${dmInfo.messageContent}"`,
        actions: ["SEND_DM_RESPONSE"],
        source: message.content.source,
      };

      if (callback) {
        await callback?.(response);
      }
      return { success: true, text: response.text };
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:send-dm",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error sending DM"
      );

      // Handle specific Discord API errors
      if (error instanceof Error) {
        if (error.message.includes("Cannot send messages to this user")) {
          if (callback) {
            await callback?.({
              text: "I couldn't send a message to that user. They may have DMs disabled or we don't share a server.",
              source: "discord",
            });
          }
        } else {
          if (callback) {
            await callback?.({
              text: "I encountered an error while trying to send the direct message. Please make sure I have the necessary permissions.",
              source: "discord",
            });
          }
        }
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default sendDM;
