import {
  type Action,
  type ActionExample,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { User } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";

/**
 * Template for extracting DM recipient and message information from the user's request.
 *
 * @type {string}
 * @description This template is used to determine who the user wants to send a DM to and what message to send.
 *
 * @param {string} recentMessages - Placeholder for recent messages related to the request.
 * @param {string} senderName - Name of the sender requesting to send a DM.
 *
 * @returns {string} - Formatted template with instructions and JSON structure for response.
 */
export const dmInfoTemplate = `# Messages we are searching for DM information
{{recentMessages}}

# Instructions: {{senderName}} is requesting to send a direct message to a specific Discord user. Your goal is to determine:
1. The recipient they want to message (could be a username, user ID, or mentioned user)
2. The message content they want to send

Extract the recipient identifier and the message content from their request.
- If they mention a user like @username or <@userid>, extract that
- If they provide a username or display name, extract that
- If they provide a user ID (long number), extract that
- Extract the complete message they want to send

Your response must be formatted as a JSON block with this structure:
\`\`\`json
{
  "recipientIdentifier": "<username|user-id|@mention>",
  "messageContent": "<the message to send>"
}
\`\`\`
`;

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
  state: State,
): Promise<{ recipientIdentifier: string; messageContent: string } | null> => {
  const prompt = composePromptFromState({
    state,
    template: dmInfoTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      recipientIdentifier: string;
      messageContent: string;
    } | null;

    if (parsedResponse && parsedResponse.recipientIdentifier && parsedResponse.messageContent) {
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
  currentServerId?: string,
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
          m.user.tag.toLowerCase() === identifier.toLowerCase(),
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
            m.user.tag.toLowerCase() === identifier.toLowerCase(),
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
    // Note: Using global logger here as this is a standalone function without runtime context
    return null;
  }
};

export const sendDM: Action = {
  name: "SEND_DM",
  similes: [
    "SEND_DIRECT_MESSAGE",
    "DM_USER",
    "MESSAGE_USER",
    "PRIVATE_MESSAGE",
    "SEND_PRIVATE_MESSAGE",
    "DM",
    "SEND_MESSAGE_TO_USER",
  ],
  description: "Sends a direct message to a specific Discord user.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== "discord") {
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
  ) => {
    const discordService = runtime.getService(
      DISCORD_SERVICE_NAME,
    ) as DiscordService;

    if (!discordService || !discordService.client) {
      runtime.logger.error(
        { src: "plugin:discord:action:send-dm", agentId: runtime.agentId },
        "Discord service not found or not initialized",
      );
      return;
    }

    const dmInfo = await getDMInfo(runtime, message, state);
    if (!dmInfo) {
      runtime.logger.warn(
        { src: "plugin:discord:action:send-dm", agentId: runtime.agentId },
        "Could not parse DM information from message",
      );
      await callback({
        text: "I couldn't understand who you want me to message or what to send. Please specify the recipient and the message content.",
        source: "discord",
      });
      return;
    }

    try {
      const room = (state.data && state.data.room) || (await runtime.getRoom(message.roomId));
      const currentServerId = room && room.messageServerId;

      // Find the user
      const targetUser = await findUser(
        discordService,
        dmInfo.recipientIdentifier,
        currentServerId,
      );

      if (!targetUser) {
        await callback({
          text: `I couldn't find a user with the identifier "${dmInfo.recipientIdentifier}". Please make sure the username or ID is correct.`,
          source: "discord",
        });
        return;
      }

      // Check if we can send DMs to this user
      if (targetUser.bot) {
        await callback({
          text: "I cannot send direct messages to other bots.",
          source: "discord",
        });
        return;
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

      await callback(response);
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:send-dm",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error sending DM",
      );

      // Handle specific Discord API errors
      if (error instanceof Error) {
        if (error.message.includes("Cannot send messages to this user")) {
          await callback({
            text: "I couldn't send a message to that user. They may have DMs disabled or we don't share a server.",
            source: "discord",
          });
        } else {
          await callback({
            text: "I encountered an error while trying to send the direct message. Please make sure I have the necessary permissions.",
            source: "discord",
          });
        }
      }
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a DM to @alice saying hello how are you today?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll send a direct message to alice right away.",
          actions: ["SEND_DM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you message john_doe and tell him the meeting is at 3pm?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll send john_doe a DM about the meeting time.",
          actions: ["SEND_DM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "DM user 123456789012345678 with: Thanks for your help!",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll send that thank you message as a DM right now.",
          actions: ["SEND_DM"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default sendDM;
