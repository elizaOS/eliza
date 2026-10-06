/**
 * The delegated Discord search maps connector memories built by the real
 * plugin-discord history builder to Discord snowflake and guild ids.
 */

import { ChannelType, stringToUuid, type UUID } from "@elizaos/core";
import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryFromMessage,
  type HistoryServiceInternals,
} from "../../../../plugin-discord/discord-history.ts";
import { memoryToDiscordMessageSearchResult } from "./discord-service.ts";

const AGENT_ID = stringToUuid("lifeops-discord-search-agent") as UUID;

describe("memoryToDiscordMessageSearchResult", () => {
  it("returns the Discord message snowflake and guild id", async () => {
    const guild = { id: "1000000000000000010", name: "Guild", ownerId: "1" };
    const channel = {
      id: "1000000000000000020",
      type: 0, // discord.js ChannelType.GuildText
      guild,
    };
    const message = {
      id: "1234567890123456789",
      author: {
        id: "1000000000000000003",
        username: "sender",
        bot: false,
        displayAvatarURL: () => "https://cdn.example/avatar.png",
      },
      channel,
      guild,
      content: "invoice attached",
      createdTimestamp: 1_700_000_000_000,
      url: `https://discord.com/channels/${guild.id}/${channel.id}/1234567890123456789`,
      reference: undefined,
    } as unknown as Message;
    const service: HistoryServiceInternals = {
      accountId: "default",
      client: {
        user: { id: "1000000000000000001" },
      } as unknown as HistoryServiceInternals["client"],
      runtime: {
        agentId: AGENT_ID,
        logger: { debug: vi.fn(), warn: vi.fn() },
      } as unknown as HistoryServiceInternals["runtime"],
      messageManager: undefined,
      resolveDiscordEntityId: (userId: string) =>
        stringToUuid(`discord-${userId}`) as UUID,
      isOwnerAliasedDiscordUser: () => false,
      getChannelType: async () => ChannelType.GROUP,
      isGuildTextBasedChannel: (c): c is never => Boolean(c),
    };

    const memory = await buildMemoryFromMessage(service, message);

    expect(memoryToDiscordMessageSearchResult(memory)).toMatchObject({
      id: "1234567890123456789",
      guildId: guild.id,
      channelId: channel.id,
      content: "invoice attached",
    });
  });
});
