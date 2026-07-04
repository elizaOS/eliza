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

import {
  type AgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";
import type {
  GetLifeOpsGmailTriageRequest,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleConnectorStatus,
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
  LifeOpsXConnectorStatus,
  LifeOpsXDm,
} from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
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

  it("resolveInboxRequest clamps limits, filters bogus channels, and defaults cache mode", () => {
    const defaults = resolveInboxRequest({});
    expect(defaults.limit).toBeGreaterThan(0);
    expect(defaults.cacheMode).toBe("read-through");
    expect(defaults.allowed.size).toBeGreaterThan(1);

    const resolved = resolveInboxRequest({
      limit: 100000,
      channels: ["gmail", "not-a-channel" as LifeOpsInboxChannel],
      cacheMode: "refresh",
    });
    expect(resolved.limit).toBe(500);
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
        inboundChat({ id: "c1", text: "signal msg", source: "signal" }),
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
    // Signal was filtered by the allow-list.
    expect(inbox.channelCounts.signal.total).toBe(0);
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
    expect(first).toBeDefined();
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
    expect(warm).toBeDefined();
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
    expect(warm).toBeDefined();
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
    expect(row).toBeDefined();
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
