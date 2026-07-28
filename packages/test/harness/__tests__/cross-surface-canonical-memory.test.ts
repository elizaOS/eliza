/**
 * Wave-1 cross-surface canonical-memory journey (P2).
 *
 * One executable proof that events from four existing connectors — Discord,
 * Telegram, email, calendar — normalize into ONE canonical agent memory
 * carrying source / account / room / sender / timestamp / trust provenance, and
 * are retrievable from a different surface **only when the destination policy
 * permits it**.
 *
 * What is real here:
 *   - a real PGLite-backed `AgentRuntime` (`withMockLlmRuntime`), real
 *     `runtime.createMemory` / `getMemories`, real migrations — not a mock store;
 *   - the REAL Discord `MessageManager.handleMessage` and the REAL
 *     `DiscordService.prototype.buildMemoryFromMessage` for the Discord leg, so
 *     the inbound→Memory mapping under test is the product's own;
 *   - the REAL Telegram `MessageManager.handleMessage` for the Telegram leg;
 *   - the real `deriveCanonicalProvenance` / `buildCanonicalRecall` glue.
 *
 * What is synthetic: the platform SDK objects at the network boundary
 * (discord.js `Message`, Telegraf `Context`) and all fixture content. Email and
 * calendar go through `ingestDomainRecord`, the narrow adapter documented in
 * `../cross-surface-fixtures.ts` — Gmail/Calendar have no production path into
 * canonical memory today, and this harness proves the envelope is
 * connector-agnostic without pre-empting that product decision.
 *
 * No live personal data: every address is `*.example.test`, every id synthetic.
 */
import {
  buildCanonicalRecall,
  type CanonicalRecallPolicy,
  canonicalDedupeKey,
  deriveCanonicalProvenance,
  failClosedRecallPolicy,
  type IAgentRuntime,
  type Memory,
  type RecallSourceHealth,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  DiscordService,
  type DiscordSettings,
  type IDiscordService,
} from "@elizaos/plugin-discord";
import { MessageManager as TelegramMessageManager } from "@elizaos/plugin-telegram";
import { ChannelType as DiscordChannelType } from "discord.js";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageManager as DiscordMessageManager } from "../../../../plugins/plugin-discord/messages.ts";
import {
  CALENDAR_ACCOUNT,
  calendarFixture,
  DISCORD_ACCOUNT_PRIMARY,
  DISCORD_ACCOUNT_SECONDARY,
  EMAIL_ACCOUNT,
  emailFixture,
  ingestDomainRecord,
  UNSUPPORTED_BACKFILL,
} from "../cross-surface-fixtures.ts";
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

let savedPassiveConnectors: string | undefined;

beforeEach(() => {
  // Passive ingest (no auto-reply) is exactly what this suite wants: it is a
  // MEMORY test, not a reply test. Leave the default on for the ingestion
  // legs; the connector still commits the inbound memory.
  savedPassiveConnectors = process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
});

afterEach(() => {
  if (savedPassiveConnectors === undefined) {
    delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
  } else {
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = savedPassiveConnectors;
  }
});

// ---------------------------------------------------------------------------
// Real-connector drivers
// ---------------------------------------------------------------------------

interface DiscordLegOptions {
  runtime: IAgentRuntime;
  text: string;
  channelId: string;
  guildId?: string;
  messageId: string;
  authorId?: string;
  accountId?: string;
}

/**
 * Drive one inbound Discord message through the REAL `MessageManager` and the
 * REAL `DiscordService.prototype.buildMemoryFromMessage`. Only the discord.js
 * SDK objects are synthetic — that is the network boundary.
 */
async function driveDiscordIngest(options: DiscordLegOptions): Promise<void> {
  const { runtime, channelId, messageId } = options;
  const guildId = options.guildId ?? "1253563208833400000";
  const authorId = options.authorId ?? "555000111222333444";
  const accountId = options.accountId ?? DISCORD_ACCOUNT_PRIMARY.accountId;

  const botMemberId = "9999999999999999999";
  const botMember = { id: botMemberId };
  const guild = {
    id: guildId,
    name: "Eliza Test Guild",
    ownerId: "1111111111111111111",
    members: { cache: new Map([[botMemberId, botMember]]) },
    fetch: async () => guild,
  };

  const channel = {
    id: channelId,
    type: DiscordChannelType.GuildText,
    name: "general",
    guild,
    client: { user: { id: botMemberId } },
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({
      id: `${Date.now()}`,
      content: "",
      url: `https://discord.com/channels/${guildId}/${channelId}/x`,
      createdTimestamp: Date.now(),
      attachments: { size: 0 },
    }),
  };

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

  const message = {
    id: messageId,
    content: options.text,
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
    mentions: { users: new Map(), repliedUser: undefined },
    react: async () => undefined,
    reactions: { resolve: () => null },
  } as never;

  const discordSettings: DiscordSettings = {
    autoReply: false,
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
      client: {
        user: { id: botMemberId },
        users: { fetch: async () => author },
      },
      accountId,
      defaultAccountId: accountId,
      discordSettings,
      ownerDiscordUserIds: new Set<string>(),
      accountPool: { get: () => null, getDefault: () => null },
    },
  );
  discordService.getChannelType =
    DiscordService.prototype.getChannelType.bind(discordService);

  const manager = new DiscordMessageManager(
    discordService as unknown as IDiscordService,
    runtime as never,
  );

  await manager.handleMessage(message);
}

/** Drive one inbound Telegram message through the REAL Telegram MessageManager. */
async function driveTelegramIngest(options: {
  runtime: IAgentRuntime;
  text: string;
  chatId: number;
  messageId: number;
  fromId?: number;
}): Promise<void> {
  const apiRoot = process.env.ELIZA_MOCK_TELEGRAM_BASE ?? "http://127.0.0.1:0/";
  const bot = new Telegraf("123456:TEST_TOKEN", { telegram: { apiRoot } });
  const manager = new TelegramMessageManager(
    bot,
    options.runtime as never,
    "default",
  );

  const chat = { id: options.chatId, type: "private", title: "Tester DM" };
  const from = {
    id: options.fromId ?? 555_001,
    is_bot: false,
    first_name: "Tester",
    username: "tester",
  };
  const ctx = {
    from,
    chat,
    message: {
      message_id: options.messageId,
      date: Math.floor(Date.now() / 1000),
      text: options.text,
      chat,
      from,
    },
    telegram: {
      sendChatAction: async () => true,
      sendMessage: async () => ({
        message_id: 1,
        chat,
        date: 0,
        text: "",
      }),
    },
  } as unknown as Context;

  await manager.handleMessage(ctx);
}

/** Read every stored message memory for a room straight out of PGLite. */
async function readRoom(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<Memory[]> {
  return runtime.getMemories({ roomId, tableName: "messages", count: 100 });
}

/**
 * Find the memory a connector just committed, by its text, without
 * re-deriving the connector's room-key scheme in the test.
 *
 * Room ids are the connector's own business (`createUniqueUuid` over a
 * connector-scoped key). Recomputing that here would make the harness assert
 * against a copy of the product's logic instead of the product's logic, and
 * would silently rot if a connector rescoped its keys. Reading the store back
 * and locating the row by content proves the REAL mapping ran and hands us the
 * room id the connector actually chose.
 */
async function findCommitted(
  runtime: IAgentRuntime,
  match: string,
): Promise<Memory | undefined> {
  const all = await runtime.getAllMemories();
  return all.find((memory) => memory.content?.text?.includes(match));
}

function ok(source: string): RecallSourceHealth {
  return { source, state: "ok" };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("wave-1 cross-surface canonical memory", () => {
  it("normalizes a real Discord ingest into provenance with source/account/room/sender/timestamp/trust", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const channelId = "1253563208833433701";
    await driveDiscordIngest({
      runtime,
      text: "The staging deploy key rotates on the 14th.",
      channelId,
      messageId: "1253563208833433999",
    });

    const inbound = await findCommitted(runtime, "staging deploy key");

    expect(
      inbound,
      "the REAL Discord connector committed the inbound message to canonical memory",
    ).toBeDefined();
    if (!inbound) return;
    const roomId = inbound.roomId;

    const provenance = deriveCanonicalProvenance(inbound, runtime.agentId);

    // Every provenance field the pillar requires, derived from what the REAL
    // connector stamped — not from anything this test wrote.
    expect(
      provenance.source,
      "source normalizes to the canonical surface",
    ).toBe("discord");
    expect(
      provenance.roomId,
      "room provenance is the room the connector itself chose",
    ).toBe(roomId);
    expect(provenance.senderId, "sender provenance is the inbound entity").toBe(
      inbound.entityId,
    );
    expect(
      provenance.timestampMs,
      "timestamp provenance is populated",
    ).toBeGreaterThan(0);
    expect(
      provenance.trust,
      "a connector-stamped platform identity yields connector-verified trust",
    ).toBe("connector-verified");
    expect(
      provenance.senderPlatformId,
      "the stable Discord user id survives into provenance",
    ).toBe("555000111222333444");
  });

  it("recalls a Discord fact on a Telegram DM surface when the destination is private", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    // Surface A: a fact arrives on Discord, through the real connector.
    const channelId = "1253563208833433702";
    await driveDiscordIngest({
      runtime,
      text: "Warehouse inventory audit is scheduled for Thursday.",
      channelId,
      messageId: "1253563208833434001",
    });
    const discordFact = await findCommitted(runtime, "inventory audit is");
    expect(
      discordFact,
      "the REAL Discord connector committed the fact to recall",
    ).toBeDefined();
    if (!discordFact) return;
    const discordRoom = discordFact.roomId;

    // Surface B: a private Telegram DM, also through the real connector, is
    // where the recall will be rendered.
    const chatId = -1002;
    await driveTelegramIngest({
      runtime,
      text: "When is the inventory audit?",
      chatId,
      messageId: 400,
    });
    const telegramTurn = await findCommitted(
      runtime,
      "When is the inventory audit?",
    );
    expect(
      telegramTurn,
      "the REAL Telegram connector committed its inbound turn, giving us a genuine destination room",
    ).toBeDefined();
    if (!telegramTurn) return;
    const telegramRoom = telegramTurn.roomId;

    expect(
      telegramRoom,
      "the two surfaces really are different rooms, so this is a cross-surface recall",
    ).not.toBe(discordRoom);

    const candidates = await readRoom(runtime, discordRoom);
    expect(
      candidates.length,
      "the Discord room holds the fact to recall",
    ).toBeGreaterThan(0);

    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      // A 1:1 DM: positively resolved as non-group.
      destination: {
        roomId: telegramRoom,
        chatType: "dm",
        isGroup: false,
      },
      sources: [ok("discord"), ok("telegram")],
    });

    expect(
      recall.availability,
      "both surfaces healthy means a complete answer",
    ).toBe("complete");
    expect(
      recall.items.some((item) =>
        item.memory.content?.text?.includes("inventory audit"),
      ),
      "the Discord-origin fact is recallable on the Telegram surface",
    ).toBe(true);

    // Provenance travels with the recalled item, so the answer can cite it.
    const hit = recall.items.find((item) =>
      item.memory.content?.text?.includes("inventory audit"),
    );
    expect(hit?.provenance.source, "the recalled item cites its surface").toBe(
      "discord",
    );
    expect(
      hit?.provenance.roomId,
      "the recalled item cites its origin room, not the destination",
    ).toBe(discordRoom);
  });

  it("recalls an email fact into a private Discord DM and keeps email provenance", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const mailboxRoom = stringToUuid("gmail-mailbox-room") as UUID;
    const sentAt = Date.now() - 60_000;
    await ingestDomainRecord(
      runtime,
      emailFixture({
        roomId: mailboxRoom,
        timestampMs: sentAt,
        subject: "Invoice 8842 approved",
        body: "Finance approved invoice 8842; payment lands next Tuesday.",
      }),
    );

    const dmRoom = stringToUuid("discord-owner-dm-room") as UUID;
    const candidates = await readRoom(runtime, mailboxRoom);

    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: dmRoom, chatType: "dm", isGroup: false },
      sources: [ok("gmail"), ok("discord")],
    });

    const hit = recall.items.find((item) =>
      item.memory.content?.text?.includes("invoice 8842"),
    );
    expect(
      hit,
      "the email fact is recallable in a private Discord DM",
    ).toBeDefined();
    expect(hit?.provenance.source, "email provenance is preserved").toBe(
      "gmail",
    );
    expect(
      hit?.provenance.accountId,
      "the originating mail account is preserved",
    ).toBe(EMAIL_ACCOUNT.accountId);
    expect(
      hit?.provenance.trust,
      "a stamped sender identity yields connector-verified trust",
    ).toBe("connector-verified");
    expect(
      hit?.provenance.timestampMs,
      "the email's own timestamp is the provenance timestamp",
    ).toBe(sentAt);
  });

  it("recalls a calendar event with source freshness", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const calendarRoom = stringToUuid("gcal-primary-room") as UUID;
    const eventStart = Date.now() + 3_600_000;
    await ingestDomainRecord(
      runtime,
      calendarFixture({
        roomId: calendarRoom,
        startMs: eventStart,
        title: "Quarterly planning sync",
        location: "Room 4B",
      }),
    );

    const voiceRoom = stringToUuid("voice-session-room") as UUID;
    const candidates = await readRoom(runtime, calendarRoom);

    // Pin the clock so the freshness assertion is exact, not timing-dependent.
    const fixedNow = eventStart + 120_000;
    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: voiceRoom, chatType: "dm", isGroup: false },
      sources: [ok("google-calendar")],
      now: () => fixedNow,
    });

    const hit = recall.items.find((item) =>
      item.memory.content?.text?.includes("Quarterly planning sync"),
    );
    expect(
      hit,
      "the calendar event is recallable on the voice/text surface",
    ).toBeDefined();
    expect(hit?.provenance.source).toBe("google-calendar");
    expect(hit?.provenance.accountId).toBe(CALENDAR_ACCOUNT.accountId);

    const calendarHealth = recall.sources.find(
      (source) => source.source === "google-calendar",
    );
    expect(
      calendarHealth?.freshnessMs,
      "the calendar source reports how stale its freshest item is",
    ).toBe(120_000);
  });

  it("surfaces a connector partial failure as partial/unavailable, never a healthy empty state", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const mailboxRoom = stringToUuid("gmail-partial-room") as UUID;
    await ingestDomainRecord(
      runtime,
      emailFixture({
        roomId: mailboxRoom,
        timestampMs: Date.now() - 5_000,
        subject: "Shipment delayed",
        body: "The Rotterdam shipment slips by two days.",
      }),
    );

    const dmRoom = stringToUuid("partial-dm-room") as UUID;
    const candidates = await readRoom(runtime, mailboxRoom);

    // Email answered; calendar is down.
    const partial = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: dmRoom, chatType: "dm", isGroup: false },
      sources: [
        ok("gmail"),
        {
          source: "google-calendar",
          state: "unavailable",
          reason: "OAuth token revoked",
        },
      ],
    });

    expect(
      partial.availability,
      "one dead source with surviving results is PARTIAL, not complete",
    ).toBe("partial");
    expect(
      partial.items.length,
      "the healthy source still answers",
    ).toBeGreaterThan(0);
    expect(
      partial.sources.find((s) => s.source === "google-calendar")?.reason,
      "the failure reason is carried for the operator",
    ).toBe("OAuth token revoked");

    // Every source down and nothing to show: UNAVAILABLE, never a confident
    // empty answer. This is the distinction the pillar calls out.
    const dead = buildCanonicalRecall({
      candidates: [],
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: dmRoom, chatType: "dm", isGroup: false },
      sources: [
        { source: "gmail", state: "unavailable", reason: "network error" },
      ],
    });
    expect(
      dead.availability,
      "no results plus a failed source must never read as a healthy empty state",
    ).toBe("unavailable");
    expect(dead.items).toHaveLength(0);
  });

  it("collapses a duplicate webhook delivery to one canonical item", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const mailboxRoom = stringToUuid("gmail-idempotency-room") as UUID;
    const record = emailFixture({
      roomId: mailboxRoom,
      platformRecordId: "gmail-msg-duplicate-1",
      timestampMs: Date.now() - 30_000,
      subject: "Duplicate delivery",
      body: "This webhook fires twice.",
    });

    // Same record delivered twice — the classic at-least-once webhook.
    await ingestDomainRecord(runtime, record);
    await ingestDomainRecord(runtime, record);

    const candidates = await readRoom(runtime, mailboxRoom);
    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: mailboxRoom, chatType: "dm", isGroup: false },
      sources: [ok("gmail")],
    });

    const hits = recall.items.filter((item) =>
      item.memory.content?.text?.includes("This webhook fires twice"),
    );
    expect(
      hits,
      "a redelivered webhook collapses to exactly one canonical item",
    ).toHaveLength(1);
  });

  it("keeps account identity distinct when the same content arrives on two accounts", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const roomA = stringToUuid("dual-account-room-a") as UUID;
    const roomB = stringToUuid("dual-account-room-b") as UUID;
    const sameText = "Quarterly numbers are final.";
    const timestampMs = Date.now() - 10_000;

    await ingestDomainRecord(
      runtime,
      emailFixture({
        roomId: roomA,
        platformRecordId: "shared-platform-id",
        timestampMs,
        body: sameText,
        account: {
          accountId: DISCORD_ACCOUNT_PRIMARY.accountId,
          label: "acct A",
        },
      }),
    );
    await ingestDomainRecord(
      runtime,
      emailFixture({
        roomId: roomB,
        platformRecordId: "shared-platform-id",
        timestampMs,
        body: sameText,
        account: {
          accountId: DISCORD_ACCOUNT_SECONDARY.accountId,
          label: "acct B",
        },
      }),
    );

    const candidates = [
      ...(await readRoom(runtime, roomA)),
      ...(await readRoom(runtime, roomB)),
    ];

    const keys = new Set(
      candidates.map((memory) =>
        canonicalDedupeKey(deriveCanonicalProvenance(memory, runtime.agentId)),
      ),
    );
    expect(
      keys.size,
      "identical content under two accounts must NOT collapse: account identity is part of the key",
    ).toBe(2);

    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: roomA, chatType: "dm", isGroup: false },
      sources: [ok("gmail")],
    });
    const accounts = new Set(
      recall.items.map((item) => item.provenance.accountId),
    );
    expect(
      accounts,
      "both originating accounts survive into the recalled provenance",
    ).toEqual(
      new Set([
        DISCORD_ACCOUNT_PRIMARY.accountId,
        DISCORD_ACCOUNT_SECONDARY.accountId,
      ]),
    );
  });

  it("fails closed on group-room retrieval until the destination-policy contract lands", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const mailboxRoom = stringToUuid("gmail-groupleak-room") as UUID;
    await ingestDomainRecord(
      runtime,
      emailFixture({
        roomId: mailboxRoom,
        timestampMs: Date.now() - 20_000,
        subject: "Salary review",
        body: "Confidential compensation details for the review cycle.",
      }),
    );

    const groupRoom = stringToUuid("discord-group-room") as UUID;
    const candidates = await readRoom(runtime, mailboxRoom);

    // The OWNER is the one asking — the exact case that leaks today, where
    // sender authorization is mistaken for destination authorization.
    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: {
        requesterEntityId: stringToUuid("owner-entity") as UUID,
        isOwner: true,
        role: "OWNER",
      },
      destination: {
        roomId: groupRoom,
        chatType: "group",
        isGroup: true,
        participantEntityIds: [
          stringToUuid("owner-entity") as UUID,
          stringToUuid("other-human") as UUID,
        ],
      },
      sources: [ok("gmail")],
    });

    expect(
      recall.items,
      "owner-private email context must NOT enter a group room, even when the owner asks",
    ).toHaveLength(0);
    expect(
      recall.withheld.some((w) => w.code === "policy_contract_pending"),
      "the withholding is explicit and attributed to the missing audience policy",
    ).toBe(true);
    expect(
      recall.policyId,
      "the receipt records which policy made the decision",
    ).toBe(failClosedRecallPolicy.id);

    // An unresolved destination is also refused — never guessed to be a DM.
    const unresolved = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: stringToUuid("mystery-room") as UUID },
      sources: [ok("gmail")],
    });
    expect(
      unresolved.items,
      "an unresolved audience is treated as unsafe, not as a DM",
    ).toHaveLength(0);
    expect(
      unresolved.withheld[0]?.code,
      "the refusal names the unresolved destination",
    ).toBe("destination_unresolved");
  });

  it("lets a real destination policy be swapped in without changing call sites", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const mailboxRoom = stringToUuid("gmail-policy-seam-room") as UUID;
    await ingestDomainRecord(
      runtime,
      emailFixture({
        roomId: mailboxRoom,
        timestampMs: Date.now() - 20_000,
        subject: "Team offsite",
        body: "The offsite is confirmed for the 3rd.",
      }),
    );

    const groupRoom = stringToUuid("policy-seam-group") as UUID;
    const candidates = await readRoom(runtime, mailboxRoom);

    // A stand-in for the real audience policy: it authorizes this specific
    // group disclosure. The call site is byte-identical to the fail-closed
    // case above — only the injected policy differs. That is the seam.
    const permissivePolicy: CanonicalRecallPolicy = {
      id: "test-audience-policy",
      decide: () => ({ allow: true }),
    };

    const recall = buildCanonicalRecall({
      candidates,
      agentId: runtime.agentId,
      requester: { requesterEntityId: runtime.agentId, isOwner: true },
      destination: { roomId: groupRoom, chatType: "group", isGroup: true },
      sources: [ok("gmail")],
      policy: permissivePolicy,
    });

    expect(
      recall.items.length,
      "an installed policy that authorizes the destination unblocks the recall",
    ).toBeGreaterThan(0);
    expect(
      recall.policyId,
      "the receipt attributes the decision to the installed policy",
    ).toBe("test-audience-policy");
  });

  it("keeps unsupported personal-history backfill explicit rather than simulated", () => {
    // The harness proves live/bot + domain-source INGESTION. It must never be
    // read as proof that a human's prior Telegram DMs or WhatsApp chats can be
    // imported — no connector in this repo can do that.
    const surfaces = UNSUPPORTED_BACKFILL.map((entry) => entry.surface);
    expect(surfaces).toContain("telegram");
    expect(surfaces).toContain("whatsapp");
    for (const entry of UNSUPPORTED_BACKFILL) {
      expect(
        entry.capability,
        "the unsupported capability is named precisely",
      ).toBe("personal-account-history-backfill");
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});
