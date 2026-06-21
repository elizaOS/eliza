/**
 * Keyless Discord connector loop e2e (#8801, criterion 5).
 *
 * Unlike the generic {@link connector-loop.test.ts} (which drives
 * `runtime.messageService.handleMessage` directly), this exercises the Discord
 * connector's REAL code path. A synthetic inbound `discord.js` `Message` goes
 * through the REAL `MessageManager.handleMessage` (the same entrypoint the
 * gateway `MessageCreate` listener calls). That does the real inbound guards,
 * envelope formatting, and `ensureConnection`, then calls the REAL
 * `DiscordService.prototype.buildMemoryFromMessage` (constructed via
 * `Object.create(DiscordService.prototype)`, so the inbound→Memory mapping is
 * the product's own, NOT reimplemented here), routes the forced-reply turn
 * through the deterministic mock LLM, and delivers the agent's reply via the
 * connector's REAL outbound seam (`channel.send`, through `sendMessageInChunks`).
 *
 * The ONLY mocks are the external `discord.js` SDK objects (Client, Channel,
 * Message). discord.js REST is hardcoded to Discord's API with no env override,
 * so capturing `channel.send` IS the correct outbound seam — no bot token, no
 * discord.com, no network.
 */
import {
  DiscordService,
  type DiscordSettings,
  type IDiscordService,
} from "@elizaos/plugin-discord";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// MessageManager is not in the plugin barrel; import the REAL class from source.
// Vitest aliases @elizaos/plugin-discord to the same source tree, so the
// DiscordService/types above and this MessageManager share module identity.
import { MessageManager } from "../../../../plugins/plugin-discord/messages.ts";
import { type MockLlmRuntime, withMockLlmRuntime } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

/** A captured outbound `channel.send` payload (the discord.js SDK boundary). */
interface SentMessage {
  channelId: string;
  content: string;
}

let savedPassiveConnectors: string | undefined;

beforeEach(() => {
  // The auto-reply gate ORs `!autoReply` with `lifeOpsPassiveConnectorsEnabled`,
  // which defaults to TRUE when unset (passive ingest, no reply). Pin it off so
  // an explicitly-invoked turn actually generates and delivers a reply.
  savedPassiveConnectors = process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
  process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
});

afterEach(() => {
  if (savedPassiveConnectors === undefined) {
    delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
  } else {
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = savedPassiveConnectors;
  }
});

describe("discord connector loop (keyless)", () => {
  it("drives a synthetic Discord message through the mock LLM to a delivered reply", async () => {
    // Heuristic (non-strict) proxy: the reply turn makes several model calls;
    // let the proxy answer them deterministically without hand fixtures.
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const sent: SentMessage[] = [];

    // ---- discord.js SDK boundary mocks (Client / Channel / Message) ----------

    // Minimal mock Client. `client.user` is null here (no bot identity), which
    // is fine: with strict mention-mode off and auto-reply on, the connector
    // does not gate on the bot being @-mentioned.
    const captureClient = {
      user: null,
      users: {
        fetch: async () => {
          throw new Error(
            "client.users.fetch should not be called for a guild channel reply",
          );
        },
      },
    };

    const channelId = "1253563208833433701";
    const guildId = "1253563208833400000";

    // Bot member resolved from the guild members cache so `canSendMessage`'s
    // guild-permission check passes (ViewChannel/SendMessages/ReadMessageHistory).
    const botMemberId = "9999999999999999999";
    const botMember = { id: botMemberId };
    const guild = {
      id: guildId,
      name: "Eliza Test Guild",
      ownerId: "1111111111111111111",
      members: { cache: new Map([[botMemberId, botMember]]) },
      // message.guild.fetch() is awaited in handleMessage for guild messages.
      fetch: async () => guild,
    };

    // The outbound seam. `sendMessageInChunks` calls `channel.send(options)`;
    // capturing it is the same surface that, in production, POSTs to Discord's
    // REST `/channels/:id/messages` endpoint.
    const channel = {
      id: channelId,
      type: DiscordChannelType.GuildText,
      name: "general",
      guild,
      client: {
        user: { id: botMemberId },
      },
      isThread: () => false,
      // canSendMessage(): bot member has all required permissions.
      permissionsFor: () => ({ has: () => true }),
      send: async (
        options: string | { content?: string },
      ): Promise<unknown> => {
        const content =
          typeof options === "string" ? options : (options.content ?? "");
        const id = `${Date.now()}${sent.length}`;
        sent.push({ channelId, content });
        return {
          id,
          content,
          url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
          createdTimestamp: Date.now(),
          attachments: { size: 0 },
        };
      },
    };

    const authorId = "555000111222333444";
    const author = {
      id: authorId,
      bot: false,
      username: "tester",
      globalName: "Tester",
      displayName: "Tester",
      discriminator: "0",
      displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
      send: async () => ({ id: "dm" }),
    };

    const messageId = "1253563208833433999";
    const message = {
      id: messageId,
      content: "Hello agent, please reply.",
      createdTimestamp: Date.now(),
      author,
      member: { displayName: "Tester", nickname: undefined },
      channel,
      guild,
      url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
      interaction: null,
      reference: undefined,
      embeds: [],
      stickers: { size: 0 },
      attachments: { size: 0 },
      mentions: {
        users: new Map(),
        repliedUser: undefined,
      },
      react: async () => undefined,
      reactions: { resolve: () => null },
    } as never;

    // ---- REAL DiscordService, REAL MessageManager ----------------------------

    // Construct the service so its prototype methods (buildMemoryFromMessage,
    // getChannelType, resolveDiscordEntityId, getAccountState,
    // createAccountServiceFacade) are the REAL ones. We only set the backing
    // state those real methods read. The empty account pool means
    // getAccountState() returns null, so the facade resolves everything from
    // these parent fields.
    const discordSettings: DiscordSettings = {
      autoReply: true,
      shouldRespondOnlyToMentions: false,
      shouldIgnoreBotMessages: true,
      shouldIgnoreDirectMessages: true,
      dmPolicy: "open",
      replyToMode: "first",
    };

    const discordService = Object.assign(
      Object.create(DiscordService.prototype),
      {
        runtime,
        client: captureClient,
        accountId: "default",
        defaultAccountId: "default",
        discordSettings,
        ownerDiscordUserIds: new Set<string>(),
        // The REAL getAccountState reads this.accountPool. An empty pool returns
        // null for the default account, so createAccountServiceFacade(null) falls
        // through to the parent fields above (client, settings, runtime).
        accountPool: { get: () => null, getDefault: () => null },
      },
    );

    // The MessageManager constructor copies `discordService.getChannelType` by
    // reference (unbound). Bind the REAL method to the service so both the
    // manager's call site and the service facade run it with correct `this`.
    discordService.getChannelType =
      DiscordService.prototype.getChannelType.bind(discordService);

    const manager = new MessageManager(
      discordService as unknown as IDiscordService,
      runtime as never,
    );

    // The same entrypoint the gateway MessageCreate listener calls.
    await manager.handleMessage(message);

    // The loop closed end-to-end through the REAL connector: the inbound message
    // ran through the REAL buildMemoryFromMessage + message pipeline + mock LLM,
    // and a non-empty reply was delivered back to the inbound channel via the
    // REAL outbound seam, at zero external cost.
    expect(
      sent.length,
      "the connector delivered at least one outbound reply",
    ).toBeGreaterThan(0);
    expect(
      sent[0]?.content.trim().length,
      "the delivered reply carries text",
    ).toBeGreaterThan(0);
    expect(
      sent[0]?.channelId,
      "the reply went back to the inbound channel",
    ).toBe(channelId);
  }, 60_000);
});
