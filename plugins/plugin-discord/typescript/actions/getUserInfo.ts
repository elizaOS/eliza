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
import type { GuildMember } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";
// Import generated prompts
import { getUserInfoTemplate } from "../../dist/prompts/typescript/prompts.js";

const getUserIdentifier = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State,
): Promise<{
  userIdentifier: string;
  detailed: boolean;
} | null> => {
  const prompt = composePromptFromState({
    state,
    template: getUserInfoTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response);
    if (parsedResponse && parsedResponse.userIdentifier) {
      return {
        userIdentifier: parsedResponse.userIdentifier,
        detailed: parsedResponse.detailed === true,
      };
    }
  }
  return null;
};

const formatUserInfo = (
  member: GuildMember,
  detailed: boolean = false,
): string => {
  const user = member.user;
  const joinedAt = member.joinedAt
    ? new Date(member.joinedAt).toLocaleDateString()
    : "Unknown";
  const createdAt = new Date(user.createdAt).toLocaleDateString();
  const roles =
    member.roles.cache
      .filter((role) => role.name !== "@everyone")
      .map((role) => role.name)
      .join(", ") || "No roles";

  const basicInfo = [
    "👤 **User Information**",
    `**Username:** ${user.username}${user.discriminator !== "0" ? `#${user.discriminator}` : ""}`,
    `**Display Name:** ${member.displayName}`,
    `**ID:** ${user.id}`,
    `**Bot:** ${user.bot ? "Yes" : "No"}`,
    `**Account Created:** ${createdAt}`,
  ];

  if (detailed) {
    const serverInfo = [
      "",
      "🏛️ **Server Information**",
      `**Nickname:** ${member.nickname || "None"}`,
      `**Joined Server:** ${joinedAt}`,
      `**Roles:** ${roles}`,
      `**Highest Role:** ${member.roles.highest.name}`,
      `**Permissions:** ${member.permissions.toArray().slice(0, 5).join(", ")}${member.permissions.toArray().length > 5 ? "..." : ""}`,
      `**Voice Channel:** ${member.voice.channel ? member.voice.channel.name : "Not in voice"}`,
      `**Status:** ${(member.presence && member.presence.status) || "offline"}`,
    ];
    return [...basicInfo, ...serverInfo].join("\n");
  }

  return basicInfo.join("\n");
};

export const getUserInfo: Action = {
  name: "GET_USER_INFO",
  similes: [
    "GET_USER_INFO",
    "USER_INFO",
    "WHO_IS",
    "ABOUT_USER",
    "USER_DETAILS",
    "MEMBER_INFO",
    "CHECK_USER",
  ],
  description:
    "Get detailed information about a Discord user including their roles, join date, and permissions.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    return message.content.source === "discord";
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
      await callback({
        text: "Discord service is not available.",
        source: "discord",
      });
      return;
    }

    const userInfo = await getUserIdentifier(runtime, message, state);
    if (!userInfo) {
      await callback({
        text: "I couldn't understand which user you want information about. Please specify a username or mention.",
        source: "discord",
      });
      return;
    }

    try {
      const room = (state.data && state.data.room) || (await runtime.getRoom(message.roomId));
      const serverId = room && room.messageServerId;
      if (!serverId) {
        await callback({
          text: "I couldn't determine the current server.",
          source: "discord",
        });
        return;
      }

      const guild = await discordService.client.guilds.fetch(serverId);

      let member: GuildMember | null = null;

      // Handle "self" request
      if (userInfo.userIdentifier === "self") {
        const authorId =
          (message.content as any).user_id || (message.content as any).userId;
        if (authorId && typeof authorId === "string") {
          const cleanId = authorId.replace("discord:", "");
          try {
            member = await guild.members.fetch(cleanId);
          } catch (_e) {
            // User not found
          }
        }
      } else {
        // Remove mention formatting if present
        const cleanIdentifier = userInfo.userIdentifier.replace(/[<@!>]/g, "");

        // Try to fetch by ID first
        if (/^\d+$/.test(cleanIdentifier)) {
          try {
            member = await guild.members.fetch(cleanIdentifier);
          } catch (_e) {
            // Not an ID or user not found
          }
        }

        // If not found by ID, search by username or display name
        if (!member) {
          const members = await guild.members.fetch();
          member =
            members.find(
              (m) =>
                m.user.username.toLowerCase() ===
                  userInfo.userIdentifier.toLowerCase() ||
                m.displayName.toLowerCase() ===
                  userInfo.userIdentifier.toLowerCase() ||
                (m.user.discriminator !== "0" &&
                  `${m.user.username}#${m.user.discriminator}`.toLowerCase() ===
                    userInfo.userIdentifier.toLowerCase()),
            ) || null;
        }
      }

      if (!member) {
        await callback({
          text: `I couldn't find a user with the identifier "${userInfo.userIdentifier}" in this server.`,
          source: "discord",
        });
        return;
      }

      const infoText = formatUserInfo(member, userInfo.detailed);

      const response: Content = {
        text: infoText,
        source: message.content.source,
      };

      await callback(response);
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:get-user-info",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error getting user info",
      );
      await callback({
        text: "I encountered an error while getting user information. Please try again.",
        source: "discord",
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "who is @john?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll get information about john.",
          actions: ["GET_USER_INFO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "tell me about myself",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll get your user information.",
          actions: ["GET_USER_INFO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "get detailed info on the admin user",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll get detailed information about the admin.",
          actions: ["GET_USER_INFO"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default getUserInfo;
