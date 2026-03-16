import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { Guild, GuildChannel, Role } from "discord.js";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";
import { ServiceType } from "../types";

const spec = requireProviderSpec("guildInfo");

/**
 * Represents a provider for retrieving guild/server information.
 * @type {Provider}
 * @property {string} name - The name of the guild info provider.
 * @property {Function} get - Asynchronous function that retrieves guild information
 *   based on the provided runtime, message, and optional state parameters.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {Memory} message - The message object.
 * @param {State} [state] - Optional state object.
 * @returns {Promise<Object>} A promise that resolves to an object containing guild data, values, and text.
 */
export const guildInfoProvider: Provider = {
  name: spec.name,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // If message source is not discord, return empty
    if (message.content.source !== "discord") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      return {
        data: { isInGuild: false },
        values: { isInGuild: false },
        text: "",
      };
    }

    const channelId = room.channelId ?? "";
    if (!channelId) {
      return {
        data: { isInGuild: false },
        values: { isInGuild: false },
        text: "",
      };
    }

    const discordService = runtime.getService(ServiceType.DISCORD) as DiscordService;
    if (!discordService?.client) {
      runtime.logger.warn(
        {
          src: "plugin:discord:provider:guildInfo",
          agentId: runtime.agentId,
          channelId,
        },
        "No discord client found"
      );
      return {
        data: { isInGuild: false },
        values: { isInGuild: false },
        text: "",
      };
    }

    // Try to get the channel to find the guild
    let channel = discordService.client.channels.cache.get(channelId) as GuildChannel | undefined;
    if (!channel) {
      try {
        channel = (await discordService.client.channels.fetch(channelId)) as
          | GuildChannel
          | undefined;
      } catch (fetchError) {
        runtime.logger.debug(
          {
            src: "plugin:discord:provider:guildInfo",
            agentId: runtime.agentId,
            channelId,
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
          },
          "Failed to fetch channel"
        );
      }
    }

    const guild = channel?.guild;
    if (!guild) {
      return {
        data: { isInGuild: false, channelId },
        values: { isInGuild: false },
        text: "",
      };
    }

    // Fetch guild info
    const guildInfo = await getGuildInfo(guild, discordService);

    const responseText = formatGuildInfoText(guild, guildInfo);

    return {
      data: {
        isInGuild: true,
        guildId: guild.id,
        guild: guildInfo,
      },
      values: {
        isInGuild: true,
        guildId: guild.id,
        guildName: guild.name,
        memberCount: guildInfo.memberCount,
        channelCount: guildInfo.channelCount,
      },
      text: responseText,
    };
  },
};

interface GuildInfo {
  name: string;
  memberCount: number;
  channelCount: number;
  roleCount: number;
  ownerId: string;
  ownerName: string;
  description: string | null;
  createdAt: string;
  premiumTier: number;
  premiumSubscriptionCount: number;
  channels: {
    text: Array<{ id: string; name: string }>;
    voice: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string }>;
  };
  roles: Array<{ id: string; name: string; color: string }>;
  botPermissions: {
    administrator: boolean;
    manageMessages: boolean;
    manageChannels: boolean;
    manageRoles: boolean;
  };
}

async function getGuildInfo(guild: Guild, discordService: DiscordService): Promise<GuildInfo> {
  // Get owner
  let ownerName = "Unknown";
  try {
    const owner = await guild.fetchOwner();
    ownerName = owner.user.username;
  } catch (_e) {
    // Ignore
  }

  // Get bot member for permissions
  const botMember = discordService.client?.user?.id
    ? guild.members.cache.get(discordService.client.user.id)
    : undefined;

  const botPermissions = {
    administrator: botMember?.permissions.has("Administrator") ?? false,
    manageMessages: botMember?.permissions.has("ManageMessages") ?? false,
    manageChannels: botMember?.permissions.has("ManageChannels") ?? false,
    manageRoles: botMember?.permissions.has("ManageRoles") ?? false,
  };

  // Categorize channels
  const textChannels: Array<{ id: string; name: string }> = [];
  const voiceChannels: Array<{ id: string; name: string }> = [];
  const categories: Array<{ id: string; name: string }> = [];

  guild.channels.cache.forEach((channel) => {
    const channelData = { id: channel.id, name: channel.name };
    if (channel.type === 0) {
      // GUILD_TEXT
      textChannels.push(channelData);
    } else if (channel.type === 2) {
      // GUILD_VOICE
      voiceChannels.push(channelData);
    } else if (channel.type === 4) {
      // GUILD_CATEGORY
      categories.push(channelData);
    }
  });

  // Get roles (exclude @everyone)
  const roles = guild.roles.cache
    .filter((role: Role) => role.name !== "@everyone")
    .map((role: Role) => ({
      id: role.id,
      name: role.name,
      color: role.hexColor,
    }));

  return {
    name: guild.name,
    memberCount: guild.memberCount,
    channelCount: guild.channels.cache.size,
    roleCount: guild.roles.cache.size,
    ownerId: guild.ownerId,
    ownerName,
    description: guild.description,
    createdAt: guild.createdAt.toISOString(),
    premiumTier: guild.premiumTier,
    premiumSubscriptionCount: guild.premiumSubscriptionCount ?? 0,
    channels: {
      text: textChannels,
      voice: voiceChannels,
      categories,
    },
    roles: Array.from(roles),
    botPermissions,
  };
}

function formatGuildInfoText(guild: Guild, info: GuildInfo): string {
  const lines = [
    `The current server is "${guild.name}" with ${info.memberCount} members.`,
    `The server was created on ${new Date(info.createdAt).toLocaleDateString()}.`,
  ];

  if (info.description) {
    lines.push(`Server description: ${info.description}`);
  }

  lines.push(
    `The server has ${info.channels.text.length} text channels, ${info.channels.voice.length} voice channels, and ${info.roleCount} roles.`
  );

  if (info.premiumTier > 0) {
    lines.push(
      `The server is boosted to tier ${info.premiumTier} with ${info.premiumSubscriptionCount} boosts.`
    );
  }

  return lines.join(" ");
}

export default guildInfoProvider;
