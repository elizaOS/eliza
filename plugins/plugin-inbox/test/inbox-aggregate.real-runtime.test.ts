/**
 * Tests for the cross-channel inbox aggregation domain that moved from
 * plugin-personal-assistant (`lifeops/domains/inbox-service.ts`) into
 * `src/inbox/aggregate.ts` (#8652 port).
 *
 * The subject — builders, request resolver, LLM-score orchestration, and the
 * cached read-through `InboxDomain` — is REAL, running against a REAL
 * PGLite-backed AgentRuntime. The injected pieces are the domain's typed host
 * seams, exercised with contract-true implementations:
 *   - `InboxMessageCache` — an in-memory store honoring the channel /
 *     maxResults / markRead contract (the production impl is PA's
 *     LifeOpsRepository over `life_inbox_messages`).
 *   - `GmailInboxSource` / `XDmInboxSource` — connector projections feeding a
 *     realistic Gmail triage feed.
 *   - `PriorityScoringSettingsLoader` — the owner policy seam.
 * Only TEXT_SMALL is a deterministic handler (the LLM boundary).
 */

import type {
  GetLifeOpsGmailTriageRequest,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleConnectorStatus,
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
} from "@elizaos/contracts";
import {
  type AgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  buildInbox,
  type CachedInboxMessage,
  InboxDomain,
  type InboxMessageCache,
  normalizeInboxChannel,
  type PriorityScoringSettings,
  resolveInboxRequest,
  toInboxMessages,
} from "../src/inbox/aggregate.ts";
import { fetchGmailMessages } from "../src/inbox/message-fetcher.ts";
import type { InboundMessage } from "../src/inbox/types.ts";

// ---------------------------------------------------------------------------
// Host-seam implementations (contract-true, in-memory)
// ---------------------------------------------------------------------------

/** In-memory implementation of the `InboxMessageCache` host seam. */
class MemoryInboxCache implements InboxMessageCache {
  rows = new Map<string, CachedInboxMessage>();
  listCalls = 0;
  upsertCalls = 0;

  seed(message: LifeOpsInboxMessage, cachedAt: string): void {
    this.rows.set(message.id, { ...message, cachedAt });
  }

  async listCachedInboxMessages(
    _agentId: string,
    options?: {
      channels?: readonly LifeOpsInboxChannel[];
      maxResults?: number;
      gmailAccountId?: string;
    },
  ): Promise<CachedInboxMessage[]> {
    this.listCalls += 1;
    const channels = options?.channels ? new Set(options.channels) : null;
    const out = [...this.rows.values()]
      .filter((row) => !channels || channels.has(row.channel))
      .filter(
        (row) =>
          !options?.gmailAccountId ||
          row.gmailAccountId === options.gmailAccountId,
      )
      .sort((a, b) => b.timestamp - a.timestamp);
    return typeof options?.maxResults === "number"
      ? out.slice(0, options.maxResults)
      : out;
  }

  async upsertCachedInboxMessages(
    _agentId: string,
    messages: readonly LifeOpsInboxMessage[],
  ): Promise<void> {
    this.upsertCalls += 1;
    const now = new Date().toISOString();
    for (const message of messages) {
      this.rows.set(message.id, { ...message, cachedAt: now });
    }
  }

  async markCachedInboxMessageRead(
    _agentId: string,
    inboxEntryId: string,
  ): Promise<LifeOpsInboxMessage | null> {
    const row = this.rows.get(inboxEntryId);
    if (!row) return null;
    const updated = {
      ...row,
      unread: false,
      lastSeenAt: new Date().toISOString(),
    };
    this.rows.set(inboxEntryId, updated);
    return updated;
  }
}

function gmailSummary(
  overrides: Partial<LifeOpsGmailMessageSummary> & {
    id: string;
    subject: string;
    snippet: string;
  },
): LifeOpsGmailMessageSummary {
  const now = new Date().toISOString();
  return {
    externalId: `ext-${overrides.id}`,
    agentId: "agent-aggregate-tests",
    provider: "google",
    side: "owner",
    threadId: `thread-${overrides.id}`,
    from: "Ada Lovelace",
    fromEmail: "ada@example.com",
    replyTo: null,
    to: ["owner@example.com"],
    cc: [],
    receivedAt: now,
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 0,
    triageReason: "",
    labels: [],
    htmlLink: null,
    metadata: {},
    syncedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeConnectorOptions {
  /** Override the Google connector status (merged over the connected base). */
  google?: Partial<LifeOpsGoogleConnectorStatus>;
  /** When set, getGmailTriage rejects with this error after counting. */
  gmailTriageError?: Error;
  /** Override the X connector status (merged over the disconnected base). */
  x?: Partial<LifeOpsXConnectorStatus>;
  /** Inbound X DMs to serve when the X side is connected with dmRead. */
  xDms?: LifeOpsXDm[];
}

/**
 * Connector-source seam. Defaults to a connected Gmail feed + a disconnected
 * X side; tests override statuses/errors to exercise degradation paths.
 */
class FakeConnectorSources {
  gmailTriageCalls = 0;
  xDmSyncCalls = 0;

  constructor(
    private readonly feedMessages: LifeOpsGmailMessageSummary[],
    private readonly options: FakeConnectorOptions = {},
  ) {}

  async getGoogleConnectorStatus(
    _requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    return {
      provider: "google",
      side: "owner",
      mode: "local",
      defaultMode: "local",
      availableModes: ["local"],
      executionTarget: "local",
      sourceOfTruth: "local_storage",
      configured: true,
      connected: true,
      reason: "connected" as LifeOpsGoogleConnectorStatus["reason"],
      preferredByAgent: false,
      cloudConnectionId: null,
      identity: null,
      grantedCapabilities: ["google.gmail.triage"],
      grantedScopes: [],
      expiresAt: null,
      hasRefreshToken: true,
      grant: null,
      ...this.options.google,
    };
  }

  async getGmailTriage(
    _requestUrl: URL,
    _request?: GetLifeOpsGmailTriageRequest,
  ): Promise<LifeOpsGmailTriageFeed> {
    this.gmailTriageCalls += 1;
    if (this.options.gmailTriageError) {
      throw this.options.gmailTriageError;
    }
    return {
      messages: this.feedMessages,
      source: "synced",
      syncedAt: new Date().toISOString(),
      summary: {
        unreadCount: this.feedMessages.length,
        importantNewCount: 0,
        likelyReplyNeededCount: 0,
      },
    };
  }

  async getXConnectorStatus(): Promise<LifeOpsXConnectorStatus> {
    return {
      provider: "x",
      mode: "local",
      connected: false,
      grantedCapabilities: [],
      grantedScopes: [],
      identity: null,
      hasCredentials: false,
      feedRead: false,
      feedWrite: false,
      dmRead: false,
      dmWrite: false,
      dmInbound: false,
      grant: null,
      ...this.options.x,
    };
  }

  async syncXDms(): Promise<{ synced: number }> {
    this.xDmSyncCalls += 1;
    return { synced: this.options.xDms?.length ?? 0 };
  }

  async getXDms(): Promise<LifeOpsXDm[]> {
    return this.options.xDms ?? [];
  }
}

function xDm(
  overrides: Partial<LifeOpsXDm> & { id: string; text: string },
): LifeOpsXDm {
  const now = new Date().toISOString();
  return {
    agentId: "agent-aggregate-tests",
    externalDmId: `ext-${overrides.id}`,
    conversationId: `conv-${overrides.id}`,
    senderHandle: "adalovelace",
    senderId: `x-user-${overrides.id}`,
    isInbound: true,
    receivedAt: now,
    readAt: null,
    repliedAt: null,
    metadata: {},
    syncedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function inboundChat(
  overrides: Partial<InboundMessage> & { id: string; text: string },
): InboundMessage {
  return {
    source: "discord",
    roomId: `room-${overrides.id}`,
    entityId: `sender-${overrides.id}`,
    senderName: `Sender ${overrides.id}`,
    channelName: `channel-${overrides.id}`,
    channelType: "dm",
    snippet: overrides.text.slice(0, 80),
    timestamp: Date.now(),
    chatType: "dm",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure builders (moved verbatim from PA)
// ---------------------------------------------------------------------------

describe("aggregate builders", () => {
  it("keeps every Gmail message when the caller omits pagination", async () => {
    const source = new FakeConnectorSources(
      Array.from({ length: 501 }, (_, index) =>
        gmailSummary({
          id: `gmail-${index}`,
          subject: `Subject ${index}`,
          snippet: `Complete body ${index}`,
        }),
      ),
    );

    const result = await fetchGmailMessages(source, {});

    expect(result.messages).toHaveLength(501);
  });

  it("normalizeInboxChannel accepts known channels case-insensitively and rejects the rest", () => {
    expect(normalizeInboxChannel("gmail")).toBe("gmail");
    expect(normalizeInboxChannel("  Discord  ")).toBe("discord");
    expect(normalizeInboxChannel("x_dm")).toBe("x_dm");
    expect(normalizeInboxChannel("sms")).toBe("sms");
    expect(normalizeInboxChannel("slack")).toBeNull();
    expect(normalizeInboxChannel("carrier-pigeon")).toBeNull();
    expect(normalizeInboxChannel("")).toBeNull();
    expect(normalizeInboxChannel(null)).toBeNull();
    expect(normalizeInboxChannel(undefined)).toBeNull();
  });

  it("resolveInboxRequest leaves omission complete and preserves explicit pagination", () => {
    const defaults = resolveInboxRequest({});
    expect(defaults.limit).toBeUndefined();
    expect(defaults.cacheLimit).toBeUndefined();
    expect(defaults.cacheMode).toBe("read-through");
    expect(defaults.allowed.size).toBeGreaterThan(1);

    const resolved = resolveInboxRequest({
      limit: 100000,
      channels: ["gmail", "not-a-channel" as LifeOpsInboxChannel],
      cacheMode: "refresh",
    });
    expect(resolved.limit).toBe(100000);
    expect([...resolved.allowed]).toEqual(["gmail"]);
    expect(resolved.cacheMode).toBe("refresh");

    const bogusMode = resolveInboxRequest({
      cacheMode: "banana" as "refresh",
    });
    expect(bogusMode.cacheMode).toBe("read-through");
  });

  it("buildInbox groups threads, honors the channel allow-list, and counts channels", () => {
    const now = Date.now();
    const inbox = buildInbox(
      [
        inboundChat({
          id: "a1",
          text: "first in thread",
          threadId: "thr-1",
          timestamp: now - 2000,
        }),
        inboundChat({
          id: "a2",
          text: "second in thread",
          threadId: "thr-1",
          timestamp: now - 1000,
        }),
        inboundChat({ id: "b1", text: "telegram msg", source: "telegram" }),
        inboundChat({ id: "c1", text: "iMessage msg", source: "imessage" }),
      ],
      {
        limit: 10,
        allowed: new Set<LifeOpsInboxChannel>(["discord", "telegram"]),
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        groupByThread: true,
        ownerName: null,
      },
    );
    // The source-health surface is carried through verbatim.
    expect(inbox.sources).toEqual([
      { source: "chat", state: "ok", degradations: [] },
    ]);
    // iMessage was filtered by the allow-list.
    expect(inbox.channelCounts.discord.total).toBe(2);
    expect(inbox.channelCounts.telegram.total).toBe(1);
    const discordGroup = inbox.threadGroups?.find(
      (group) => group.threadId === "thr-1",
    );
    expect(discordGroup).toBeDefined();
    expect(discordGroup?.messages).toHaveLength(2);
    // Latest message wins the group headline.
    expect(discordGroup?.latestMessage.snippet).toBe("second in thread");
  });

  it("does not fabricate small-group priority scores when LLM scores are missing", () => {
    const now = Date.now();
    const inbox = buildInbox(
      [
        inboundChat({
          id: "group-1",
          text: "Ada, can you review this tomorrow at 3pm?",
          threadId: "group-thread",
          timestamp: now - 1000,
          chatType: "group",
          participantCount: 4,
        }),
      ],
      {
        limit: 10,
        allowed: new Set<LifeOpsInboxChannel>(["discord"]),
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        groupByThread: true,
        ownerName: "Ada",
        sortByPriority: true,
      },
    );

    const group = inbox.threadGroups?.[0];
    expect(group?.maxPriorityScore).toBeUndefined();
    expect(group?.priorityCategory).toBeUndefined();
    expect(group?.latestMessage.priorityScore).toBeUndefined();
    expect(inbox.messages[0]?.priorityScore).toBeUndefined();
  });

  it("uses the most common category when top LLM scores tie", () => {
    const now = Date.now();
    const messages = [
      inboundChat({
        id: "tie-important",
        text: "latest message",
        threadId: "tie-thread",
        timestamp: now,
      }),
      inboundChat({
        id: "tie-planning-1",
        text: "planning message one",
        threadId: "tie-thread",
        timestamp: now - 1000,
      }),
      inboundChat({
        id: "tie-planning-2",
        text: "planning message two",
        threadId: "tie-thread",
        timestamp: now - 2000,
      }),
      ...[0, 1, 2].map((index) =>
        inboundChat({
          id: `lower-casual-${index}`,
          text: "lower-scoring casual message",
          threadId: "tie-thread",
          timestamp: now - 3000 - index,
        }),
      ),
    ];
    const inbox = buildInbox(messages, {
      limit: 10,
      allowed: new Set<LifeOpsInboxChannel>(["discord"]),
      sources: [{ source: "chat", state: "ok", degradations: [] }],
      groupByThread: true,
      llmScores: new Map([
        [
          "discord:tie-important",
          { score: 90, category: "important", flags: [] },
        ],
        [
          "discord:tie-planning-1",
          { score: 90, category: "planning", flags: [] },
        ],
        [
          "discord:tie-planning-2",
          { score: 80, category: "planning", flags: [] },
        ],
        ...[0, 1, 2].map(
          (index) =>
            [
              `discord:lower-casual-${index}`,
              { score: 20, category: "casual", flags: [] },
            ] as const,
        ),
      ]),
    });

    expect(inbox.threadGroups?.[0]?.priorityCategory).toBe("planning");
  });

  it("uses fixed priority order for an exact tied-category frequency", () => {
    const now = Date.now();
    const inbox = buildInbox(
      [
        inboundChat({
          id: "exact-important",
          text: "important",
          threadId: "exact-thread",
          timestamp: now,
        }),
        inboundChat({
          id: "exact-planning",
          text: "planning",
          threadId: "exact-thread",
          timestamp: now - 1000,
        }),
      ],
      {
        limit: 10,
        allowed: new Set<LifeOpsInboxChannel>(["discord"]),
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        groupByThread: true,
        llmScores: new Map([
          [
            "discord:exact-important",
            { score: 90, category: "important", flags: [] },
          ],
          [
            "discord:exact-planning",
            { score: 90, category: "planning", flags: [] },
          ],
        ]),
      },
    );

    expect(inbox.threadGroups?.[0]?.priorityCategory).toBe("important");
  });

  it("missedOnly requires a real priority score instead of keyword fallback", () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    const inbox = buildInbox(
      [
        inboundChat({
          id: "missed-group-1",
          text: "Ada, are you free tomorrow at 3pm?",
          threadId: "missed-group-thread",
          timestamp: old,
          chatType: "group",
          participantCount: 5,
        }),
      ],
      {
        limit: 10,
        allowed: new Set<LifeOpsInboxChannel>(["discord"]),
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        groupByThread: true,
        ownerName: "Ada",
        missedOnly: true,
        sortByPriority: true,
      },
    );

    expect(inbox.messages).toEqual([]);
    expect(inbox.threadGroups).toEqual([]);
  });

  it("missedOnly spends the limit window only on messages that can qualify", () => {
    const now = Date.now();
    // A busy day: 100 recent messages can never qualify as missed, but they
    // are the newest rows a limit-first trim would keep.
    const flood = Array.from({ length: 100 }, (_, index) =>
      inboundChat({
        id: `missed-flood-${index}`,
        text: `noise ${index}`,
        threadId: `missed-flood-thread-${index}`,
        timestamp: now - index * 60_000,
      }),
    );
    const inbox = buildInbox(
      [
        ...flood,
        inboundChat({
          id: "missed-invoice",
          text: "Invoice is due",
          threadId: "missed-invoice-thread",
          timestamp: now - 48 * 60 * 60 * 1000,
        }),
        inboundChat({
          id: "missed-replied",
          text: "already answered",
          threadId: "missed-replied-thread",
          timestamp: now - 48 * 60 * 60 * 1000,
          repliedAt: new Date(now - 47 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      {
        limit: 24,
        allowed: new Set<LifeOpsInboxChannel>(["discord"]),
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        groupByThread: true,
        missedOnly: true,
        llmScores: new Map([
          [
            "discord:missed-invoice",
            { score: 90, category: "important", flags: [] },
          ],
          [
            "discord:missed-replied",
            { score: 90, category: "important", flags: [] },
          ],
        ]),
      },
    );

    // The unreplied 48h-old high-score message survives; the replied one
    // never qualifies and the recent flood never consumes the window.
    expect(inbox.messages.map((message) => message.id)).toEqual([
      "discord:missed-invoice",
    ]);
    expect(inbox.threadGroups?.map((group) => group.latestMessage.id)).toEqual([
      "discord:missed-invoice",
    ]);
  });

  it("missedOnly grouped view keeps whole threads, not just the missed subset", () => {
    const now = Date.now();
    // Thread AB holds a missed ask (30h old, unreplied, scored) and a newer
    // follow-up (2h old, scored, not yet missed). A replied-only thread
    // never qualifies.
    const inbox = buildInbox(
      [
        inboundChat({
          id: "missed-thread-old",
          text: "older ask that was never answered",
          threadId: "missed-thread-ab",
          timestamp: now - 30 * 60 * 60 * 1000,
        }),
        inboundChat({
          id: "missed-thread-new",
          text: "newest follow-up in the same thread",
          threadId: "missed-thread-ab",
          timestamp: now - 2 * 60 * 60 * 1000,
        }),
        inboundChat({
          id: "missed-replied",
          text: "already answered",
          threadId: "missed-replied-thread",
          timestamp: now - 30 * 60 * 60 * 1000,
          repliedAt: new Date(now - 29 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      {
        limit: 10,
        allowed: new Set<LifeOpsInboxChannel>(["discord"]),
        sources: [{ source: "chat", state: "ok", degradations: [] }],
        groupByThread: true,
        missedOnly: true,
        llmScores: new Map([
          [
            "discord:missed-thread-old",
            { score: 70, category: "important", flags: [] },
          ],
          [
            "discord:missed-thread-new",
            { score: 90, category: "important", flags: [] },
          ],
          [
            "discord:missed-replied",
            { score: 90, category: "important", flags: [] },
          ],
        ]),
      },
    );

    // The flat view stays missed-only, but the group keeps both thread
    // members: the newest message is the preview and the counts describe
    // the whole thread. The replied-only thread is dropped entirely.
    expect(inbox.messages.map((message) => message.id)).toEqual([
      "discord:missed-thread-old",
    ]);
    expect(inbox.threadGroups).toHaveLength(1);
    const group = inbox.threadGroups?.[0];
    if (!group) throw new Error("unreachable");
    expect(group.latestMessage.id).toBe("discord:missed-thread-new");
    expect(group.totalCount).toBe(2);
    expect(group.unreadCount).toBe(2);
    expect(group.messages.map((message) => message.id)).toEqual([
      "discord:missed-thread-new",
      "discord:missed-thread-old",
    ]);
  });
});

// ---------------------------------------------------------------------------
// InboxDomain — cached read-through spine on a real runtime
// ---------------------------------------------------------------------------

describe("InboxDomain on a real runtime", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  const scoringCalls: string[] = [];

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "inbox-aggregate-tests",
    });
    runtime = testResult.runtime;
    // Deterministic priority scorer (the LLM boundary): scores every listed
    // message; "invoice" snippets rank important/90, the rest casual/10.
    runtime.registerModel(
      ModelType.TEXT_SMALL as ModelTypeName,
      async (_rt, params) => {
        const prompt = String((params as { prompt?: string }).prompt);
        scoringCalls.push(prompt);
        const count = (prompt.match(/^messages\[\d+\]:/gm) ?? []).length;
        const snippets = prompt
          .split("\n")
          .filter((line) => line.trim().startsWith("snippet:"));
        const scores = Array.from({ length: count }, (_unused, i) => {
          const snippet = snippets[i]?.toLowerCase() ?? "";
          return snippet.includes("invoice")
            ? { score: 90, category: "important", flags: ["deadline"] }
            : { score: 10, category: "casual", flags: [] };
        });
        return JSON.stringify({ scores });
      },
      "inbox-aggregate-tests",
      100,
    );
  }, 120_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  function makeDomain(opts: {
    cache: MemoryInboxCache;
    sources: FakeConnectorSources;
    settings?: PriorityScoringSettings;
  }): InboxDomain {
    return new InboxDomain({
      runtime,
      cache: opts.cache,
      sources: opts.sources,
      ...(opts.settings
        ? { loadPriorityScoringSettings: async () => opts.settings }
        : {}),
    });
  }

  it("cache-only mode serves from the cache seam without touching connector sources", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([]);
    const domain = makeDomain({ cache, sources });

    const seeded = toInboxMessages([
      inboundChat({ id: "cached-1", text: "hello from cache" }),
    ]);
    const first = seeded[0];
    if (!first) throw new Error("unreachable");
    cache.seed(first, new Date().toISOString());

    const inbox = await domain.getInbox({
      channels: ["discord"],
      cacheMode: "cache-only",
    });
    expect(inbox.messages.map((message) => message.id)).toEqual([first.id]);
    expect(sources.gmailTriageCalls).toBe(0);
    expect(cache.upsertCalls).toBe(0);
  });

  it("missedOnly widens the cache read so a recent flood cannot hide missed messages", async () => {
    const readLimits: Array<number | undefined> = [];
    class RecordingCache extends MemoryInboxCache {
      override async listCachedInboxMessages(
        agentId: string,
        options?: {
          channels?: readonly LifeOpsInboxChannel[];
          maxResults?: number;
          gmailAccountId?: string;
        },
      ): Promise<CachedInboxMessage[]> {
        readLimits.push(options?.maxResults);
        return super.listCachedInboxMessages(agentId, options);
      }
    }
    const cache = new RecordingCache();
    const sources = new FakeConnectorSources([]);
    const domain = makeDomain({ cache, sources });
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const recent = toInboxMessages(
      Array.from({ length: 100 }, (_, index) =>
        inboundChat({
          id: `cache-flood-${index}`,
          text: `noise ${index}`,
          threadId: `cache-flood-thread-${index}`,
          timestamp: now - index * 60_000,
        }),
      ),
    );
    const missed = toInboxMessages([
      inboundChat({
        id: "cache-missed-invoice",
        text: "Invoice is due",
        threadId: "cache-missed-invoice-thread",
        timestamp: now - 48 * 60 * 60 * 1000,
      }),
    ])[0];
    if (!missed) throw new Error("unreachable");
    // Cached rows carry the priority score stored by a previous scored cycle.
    const scoredMissed: CachedInboxMessage = {
      ...missed,
      priorityScore: 90,
      priorityCategory: "important",
    };
    for (const message of recent) cache.seed(message, fresh);
    cache.seed(scoredMissed, fresh);

    const inbox = await domain.getInbox({
      channels: ["discord"],
      cacheMode: "cache-only",
      limit: 24,
      missedOnly: true,
      groupByThread: true,
      sortByPriority: true,
    });

    // The read must look past the display limit, and the missed row the
    // flood would have evicted comes back with its stored score.
    expect(readLimits).toEqual([undefined]);
    expect(inbox.messages.map((message) => message.id)).toEqual([
      "discord:cache-missed-invoice",
    ]);
    expect(inbox.messages[0]?.priorityScore).toBe(90);
  });

  it("missedOnly scores missed messages beyond the newest-limit window on refresh", async () => {
    // A source seam that honors the requested page size, like the real
    // triage endpoint, so the test proves the refresh read was widened.
    class HonoringConnectorSources extends FakeConnectorSources {
      override async getGmailTriage(
        requestUrl: URL,
        request?: GetLifeOpsGmailTriageRequest,
      ): Promise<LifeOpsGmailTriageFeed> {
        const feed = await super.getGmailTriage(requestUrl, request);
        return typeof request?.maxResults === "number"
          ? { ...feed, messages: feed.messages.slice(0, request.maxResults) }
          : feed;
      }
    }
    const cache = new MemoryInboxCache();
    const now = Date.now();
    const sources = new HonoringConnectorSources([
      ...Array.from({ length: 100 }, (_, index) =>
        gmailSummary({
          id: `refresh-flood-${index}`,
          subject: `Noise ${index}`,
          snippet: `casual noise ${index}`,
          threadId: `refresh-flood-thread-${index}`,
          receivedAt: new Date(now - index * 60_000).toISOString(),
        }),
      ),
      gmailSummary({
        id: "refresh-missed-invoice",
        subject: "Invoice due",
        snippet: "Your invoice is due",
        threadId: "refresh-missed-invoice-thread",
        receivedAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
      }),
    ]);
    const domain = makeDomain({ cache, sources });

    const inbox = await domain.getInbox({
      channels: ["gmail"],
      cacheMode: "refresh",
      limit: 24,
      missedOnly: true,
      groupByThread: true,
      sortByPriority: true,
    });

    expect(inbox.messages.map((message) => message.id)).toEqual([
      "gmail:ext-refresh-missed-invoice",
    ]);
    expect(inbox.messages[0]?.priorityScore).toBe(90);
  });

  it("read-through returns fresh cache without refetch, then refresh mode forces the source fetch", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([
      gmailSummary({
        id: "gm-1",
        subject: "Invoice due Friday",
        snippet: "Your invoice is due Friday",
      }),
    ]);
    const domain = makeDomain({ cache, sources });

    const seeded = toInboxMessages([
      inboundChat({ id: "warm-1", text: "warm cache row" }),
    ]);
    const warm = seeded[0];
    if (!warm) throw new Error("unreachable");
    cache.seed(warm, new Date().toISOString());

    // Fresh cache -> no connector fetch; chat health still reported.
    const cachedRead = await domain.getInbox({ channels: ["discord"] });
    expect(cachedRead.messages.map((message) => message.id)).toEqual([warm.id]);
    expect(sources.gmailTriageCalls).toBe(0);
    expect(cachedRead.sources).toEqual([
      { source: "chat", state: "ok", degradations: [] },
    ]);

    // refresh -> hits the Gmail source, upserts pre- and post-LLM, and the
    // returned inbox carries the LLM priority score.
    const refreshed = await domain.getInbox({
      channels: ["gmail"],
      cacheMode: "refresh",
    });
    expect(sources.gmailTriageCalls).toBe(1);
    expect(cache.upsertCalls).toBe(2);
    // Happy path: the pulled source reports healthy.
    expect(refreshed.sources).toEqual([
      { source: "gmail", state: "ok", degradations: [] },
    ]);
    expect(refreshed.messages).toHaveLength(1);
    const scored = refreshed.messages[0];
    expect(scored?.channel).toBe("gmail");
    expect(scored?.priorityScore).toBe(90);
    expect(scored?.priorityCategory).toBe("important");
    // The scored message landed back in the cache seam.
    const recached = await cache.listCachedInboxMessages(runtime.agentId, {
      channels: ["gmail"],
    });
    expect(recached.some((row) => row.priorityScore === 90)).toBe(true);
  });

  it("owner policy seam: scoring disabled means the model is never consulted", async () => {
    const before = scoringCalls.length;
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([
      gmailSummary({
        id: "gm-2",
        subject: "Weekly digest",
        snippet: "Casual weekly digest",
      }),
    ]);
    const domain = makeDomain({
      cache,
      sources,
      settings: { enabled: false, model: null },
    });

    const inbox = await domain.getInbox({
      channels: ["gmail"],
      cacheMode: "refresh",
    });
    expect(scoringCalls.length).toBe(before);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.priorityScore ?? null).toBeNull();
  });

  it("a degraded source with zero messages returns an explicit degraded status, not a healthy empty inbox", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([], {
      google: { connected: false, reason: "needs_reauth" },
    });
    const domain = makeDomain({ cache, sources });

    const inbox = await domain.getInbox({
      channels: ["gmail"],
      cacheMode: "refresh",
    });
    expect(inbox.messages).toEqual([]);
    expect(inbox.sources).toHaveLength(1);
    const gmail = inbox.sources[0];
    expect(gmail?.source).toBe("gmail");
    expect(gmail?.state).toBe("degraded");
    expect(gmail?.degradations.map((entry) => entry.code)).toContain(
      "gmail_needs_reauth",
    );
    expect(gmail?.degradations[0]?.axis).toBe("auth-expired");
    // Degraded means no pull was attempted against the dead grant.
    expect(sources.gmailTriageCalls).toBe(0);
  });

  it("a partial failure returns the healthy channels' messages plus a per-source warning", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([], {
      gmailTriageError: new Error("gmail 401: invalid_grant"),
      x: {
        connected: true,
        hasCredentials: true,
        dmRead: true,
        dmInbound: true,
        grantedCapabilities: ["x.dm.read"],
      },
      xDms: [xDm({ id: "dm-1", text: "hey — got a minute?" })],
    });
    const domain = makeDomain({ cache, sources });

    const inbox = await domain.getInbox({
      channels: ["gmail", "x_dm"],
      cacheMode: "refresh",
    });
    // X DMs still flow even though the Gmail pull blew up.
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.channel).toBe("x_dm");

    const bySource = new Map(
      inbox.sources.map((status) => [status.source, status]),
    );
    expect(bySource.get("x_dm")?.state).toBe("ok");
    const gmail = bySource.get("gmail");
    expect(gmail?.state).toBe("degraded");
    expect(gmail?.degradations[0]?.axis).toBe("transport-offline");
    // The real error is preserved, not swallowed.
    expect(gmail?.degradations[0]?.message).toContain("invalid_grant");
    expect(sources.gmailTriageCalls).toBe(1);
  });

  it("all sources degraded returns empty messages with every source explicitly degraded", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([], {
      google: { connected: false, reason: "needs_reauth" },
      x: { connected: false, reason: "needs_reauth" },
    });
    const domain = makeDomain({ cache, sources });

    const inbox = await domain.getInbox({
      channels: ["gmail", "x_dm"],
      cacheMode: "refresh",
    });
    expect(inbox.messages).toEqual([]);
    expect(inbox.sources).toHaveLength(2);
    for (const status of inbox.sources) {
      expect(status.state).toBe("degraded");
      expect(status.degradations.length).toBeGreaterThan(0);
    }
  });

  it("gmail connected without the triage capability reports a missing-scope degradation", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([], {
      google: { grantedCapabilities: [] },
    });
    const domain = makeDomain({ cache, sources });

    const inbox = await domain.getInbox({
      channels: ["gmail"],
      cacheMode: "refresh",
    });
    expect(inbox.messages).toEqual([]);
    expect(inbox.sources[0]?.state).toBe("degraded");
    expect(inbox.sources[0]?.degradations[0]?.axis).toBe("missing-scope");
    expect(sources.gmailTriageCalls).toBe(0);
  });

  it("a fresh-cache read still reports connector degradation via the status probe", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([], {
      google: { connected: false, reason: "needs_reauth" },
    });
    const domain = makeDomain({ cache, sources });

    const seeded = toInboxMessages([
      inboundChat({ id: "cached-degraded-1", text: "warm row" }),
    ]);
    const warm = seeded[0];
    if (!warm) throw new Error("unreachable");
    cache.seed(warm, new Date().toISOString());

    // read-through with a fresh cache: no message pull, but the response
    // still says Gmail is degraded — the whole point of the health surface.
    const inbox = await domain.getInbox({ channels: ["discord", "gmail"] });
    expect(inbox.messages.map((message) => message.id)).toEqual([warm.id]);
    expect(sources.gmailTriageCalls).toBe(0);
    const bySource = new Map(
      inbox.sources.map((status) => [status.source, status]),
    );
    expect(bySource.get("chat")?.state).toBe("ok");
    expect(bySource.get("gmail")?.state).toBe("degraded");
    expect(
      bySource.get("gmail")?.degradations.map((entry) => entry.code),
    ).toContain("gmail_needs_reauth");
  });

  it("cache-only mode probes connector health without pulling messages", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([], {
      google: { connected: false, reason: "token_missing" },
    });
    const domain = makeDomain({ cache, sources });

    const inbox = await domain.getInbox({
      channels: ["gmail"],
      cacheMode: "cache-only",
    });
    expect(inbox.messages).toEqual([]);
    expect(sources.gmailTriageCalls).toBe(0);
    expect(inbox.sources[0]?.source).toBe("gmail");
    expect(inbox.sources[0]?.state).toBe("degraded");
    expect(inbox.sources[0]?.degradations[0]?.axis).toBe("auth-expired");
  });

  it("markInboxEntryRead round-trips through the cache seam and returns null on miss", async () => {
    const cache = new MemoryInboxCache();
    const sources = new FakeConnectorSources([]);
    const domain = makeDomain({ cache, sources });

    const seeded = toInboxMessages([
      inboundChat({ id: "read-1", text: "unread row" }),
    ]);
    const row = seeded[0];
    if (!row) throw new Error("unreachable");
    cache.seed({ ...row, unread: true }, new Date().toISOString());

    const marked = await domain.markInboxEntryRead(row.id);
    expect(marked?.unread).toBe(false);
    expect(marked?.lastSeenAt).toBeTruthy();

    // Miss -> null; the HOST owns the transport mapping (PA raises 404).
    const missing = await domain.markInboxEntryRead("no-such-entry");
    expect(missing).toBeNull();
  });
});
