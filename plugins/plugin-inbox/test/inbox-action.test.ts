/**
 * `INBOX` umbrella action — unit tests.
 *
 * Asserts the cross-channel inbox surface exists, fans out across the
 * configured platforms via the injectable fetcher hook, dedupes by id + thread
 * topic, and respects the search / summarize subactions. Ported from the
 * LifeOps INBOX action tests; behavior is byte-identical.
 */

import type {
  Content,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  MessageAdapter,
  UUID,
} from "@elizaos/core";
import { getDefaultTriageService, parseInteractionBlocks } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

// inbox.ts imports hasOwnerAccess from the @elizaos/agent/security/access
// subpath (the barrel does not re-export it); mock that exact specifier or the
// real owner check runs and every subaction returns PERMISSION_DENIED.
vi.mock("@elizaos/agent/security/access", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import {
  __resetInboxFetchersForTests,
  type InboxItem,
  inboxAction,
  setInboxFetchers,
} from "../src/actions/inbox.ts";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-inbox-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function makeDbRuntime(rowsFor: (sql: string) => unknown): {
  runtime: IAgentRuntime;
  calls: Array<{ sql: string }>;
} {
  const calls: Array<{ sql: string }> = [];
  const runtime = {
    ...makeRuntime(),
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    adapter: {
      db: {
        execute: async (query: { queryChunks: Array<{ value?: unknown }> }) => {
          const chunk = query.queryChunks[0]?.value;
          const sql = Array.isArray(chunk) ? String(chunk[0]) : String(chunk);
          calls.push({ sql });
          return rowsFor(sql);
        },
      },
    },
  } as unknown as IAgentRuntime;
  return { runtime, calls };
}

function makeMessage(text = "show my inbox"): Memory {
  return {
    id: "msg-inbox-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-inbox-1" as UUID,
    content: { text },
  } as Memory;
}

async function callInbox(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  return inboxAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

function makeItem(
  overrides: Partial<InboxItem> & {
    platform: InboxItem["platform"];
    id: string;
  },
): InboxItem {
  return {
    channel: "default",
    senderName: "Alice",
    snippet: "hello",
    receivedAt: "2026-05-11T10:00:00.000Z",
    ...overrides,
  };
}

function makeTriageRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "entry-1",
    agent_id: "11111111-1111-1111-1111-111111111111",
    source: "gmail",
    source_room_id: null,
    source_entity_id: "alice@example.com",
    source_message_id: "gmail-msg-1",
    channel_name: "Email from Alice",
    channel_type: "email",
    deep_link: null,
    classification: "needs_reply",
    urgency: "high",
    confidence: 0.9,
    snippet: "Can you confirm the launch date?",
    sender_name: "Alice",
    thread_context: null,
    triage_reasoning: "asks a direct question",
    suggested_response: "Yes, Friday.",
    draft_response: null,
    auto_replied: false,
    snoozed_until: null,
    resolved: false,
    resolved_at: null,
    created_at: "2026-06-17T10:00:00.000Z",
    updated_at: "2026-06-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("INBOX umbrella action — cross-channel inbox", () => {
  beforeEach(() => {
    __resetInboxFetchersForTests();
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
  });

  describe("metadata", () => {
    it("exposes the canonical name and similes", () => {
      expect(inboxAction.name).toBe("INBOX");
      const similes = inboxAction.similes ?? [];
      for (const required of [
        "INBOX",
        "CROSS_CHANNEL_INBOX",
        "ALL_MESSAGES",
        "INBOX_TRIAGE_PRIORITY",
      ]) {
        expect(similes).toContain(required);
      }
    });

    it("exposes triage queue filter parameters to routed tool calls", () => {
      const parameterNames = new Set(
        (inboxAction.parameters ?? []).map((parameter) => parameter.name),
      );
      expect(parameterNames).toContain("classification");
      expect(parameterNames).toContain("includeSnoozed");
    });

    it("rejects calls with no subaction selector", async () => {
      const result = await callInbox(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.text).toContain("triage");
      expect(result.text).toContain("approve");
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("rejects callers that fail the owner-access check", async () => {
      mocks.hasOwnerAccess.mockResolvedValueOnce(false);
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
    });

    it("rejects when the message has no entity id (access guard)", async () => {
      const message = { id: "m" as UUID, content: { text: "x" } } as Memory;
      const result = await callInbox(makeRuntime(), message, {
        subaction: "list",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
      // The guard short-circuits before the owner-access call.
      expect(mocks.hasOwnerAccess).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("fans out to all configured platforms and orders by recency", async () => {
      setInboxFetchers({
        gmail: async () => [
          makeItem({
            id: "g-1",
            platform: "gmail",
            receivedAt: "2026-05-11T08:00:00.000Z",
          }),
        ],
        slack: async () => [
          makeItem({
            id: "s-1",
            platform: "slack",
            receivedAt: "2026-05-11T12:00:00.000Z",
          }),
        ],
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["gmail", "slack"],
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        items: { id: string; platform: string }[];
        platforms: string[];
      };
      expect(data.platforms).toEqual(["gmail", "slack"]);
      expect(data.items.map((item) => item.id)).toEqual(["s-1", "g-1"]);
    });

    it("dedupes items that share thread topic + channel + platform", async () => {
      setInboxFetchers({
        gmail: async () => [
          makeItem({
            id: "g-1",
            platform: "gmail",
            channel: "inbox",
            threadTopic: "Launch",
            receivedAt: "2026-05-11T09:00:00.000Z",
          }),
          makeItem({
            id: "g-2",
            platform: "gmail",
            channel: "inbox",
            threadTopic: "Launch",
            receivedAt: "2026-05-11T11:00:00.000Z",
          }),
        ],
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["gmail"],
      });
      const data = result.data as {
        items: { id: string }[];
        totalBeforeDedupe: number;
      };
      expect(data.totalBeforeDedupe).toBe(2);
      expect(data.items).toHaveLength(1);
      expect(data.items[0]?.id).toBe("g-2");
    });
  });

  describe("search", () => {
    it("requires a non-empty query", async () => {
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "search",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_QUERY" });
    });

    it("forwards the query to each platform fetcher", async () => {
      const gmailFetcher = vi.fn(async () => []);
      setInboxFetchers({
        gmail: gmailFetcher,
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "search",
        platforms: ["gmail"],
        query: "launch plan",
      });
      expect(result.success).toBe(true);
      expect(gmailFetcher).toHaveBeenCalledTimes(1);
      const fetcherArgs = gmailFetcher.mock.calls[0]?.[0];
      expect(fetcherArgs?.query).toBe("launch plan");
    });
  });

  describe("summarize", () => {
    it("returns per-platform counts without items", async () => {
      setInboxFetchers({
        gmail: async () => [
          makeItem({
            id: "g-1",
            platform: "gmail",
            receivedAt: "2026-05-11T09:00:00.000Z",
          }),
          makeItem({
            id: "g-2",
            platform: "gmail",
            receivedAt: "2026-05-11T10:00:00.000Z",
          }),
        ],
        slack: async () => [],
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "summarize",
        platforms: ["gmail", "slack"],
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        items: unknown[];
        summary: { platform: string; count: number; latestAt: string | null }[];
      };
      expect(data.items).toHaveLength(0);
      const summary = data.summary;
      const gmail = summary.find((s) => s.platform === "gmail");
      const slack = summary.find((s) => s.platform === "slack");
      expect(gmail?.count).toBe(2);
      expect(gmail?.latestAt).toBe("2026-05-11T10:00:00.000Z");
      expect(slack?.count).toBe(0);
      expect(slack?.latestAt).toBeNull();
    });
  });

  describe("platforms arg parsing", () => {
    it("falls back to all PLATFORMS when omitted", async () => {
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
      });
      expect(result.success).toBe(true);
      const data = result.data as { platforms: string[] };
      expect(data.platforms).toEqual([
        "gmail",
        "slack",
        "discord",
        "telegram",
        "signal",
        "imessage",
        "whatsapp",
      ]);
    });

    it("errors when the platforms list is provided but no entries match", async () => {
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["myspace", "aim"],
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "NO_PLATFORMS" });
    });
  });

  describe("empty result", () => {
    it("returns an empty list with a friendly text when no items match", async () => {
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["gmail"],
      });
      expect(result.success).toBe(true);
      const data = result.data as { items: unknown[] };
      expect(data.items).toHaveLength(0);
      expect(result.text).toContain("empty");
    });
  });

  describe("degraded platforms", () => {
    it("a failing platform is reported as degraded while healthy platforms still return items", async () => {
      setInboxFetchers({
        gmail: async () => {
          throw new Error("gmail token expired");
        },
        discord: async () => [
          makeItem({ platform: "discord", id: "d-1", snippet: "gm" }),
        ],
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["gmail", "discord"],
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        items: InboxItem[];
        degraded: Array<{ platform: string; error: string }>;
      };
      // Partial failure: discord's message survives the gmail blow-up.
      expect(data.items.map((item) => item.id)).toEqual(["d-1"]);
      expect(data.degraded).toEqual([
        { platform: "gmail", error: "gmail token expired" },
      ]);
      // The planner-visible text names the broken platform and the reason.
      expect(result.text).toContain("could not check gmail");
      expect(result.text).toContain("gmail token expired");
    });

    it("an empty result with a degraded platform is never presented as a clean empty inbox", async () => {
      setInboxFetchers({
        gmail: async () => {
          throw new Error("gmail token expired");
        },
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["gmail"],
      });
      expect(result.success).toBe(true);
      expect(result.text).not.toContain("Your inbox is empty");
      expect(result.text).toContain("No messages from reachable platforms");
      expect(result.text).toContain("could not check gmail");
      const data = result.data as {
        degraded: Array<{ platform: string; error: string }>;
      };
      expect(data.degraded).toHaveLength(1);
    });

    it("a healthy fan-out reports an empty degraded list", async () => {
      setInboxFetchers({
        gmail: async () => [makeItem({ platform: "gmail", id: "g-1" })],
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "list",
        platforms: ["gmail"],
      });
      expect(result.success).toBe(true);
      const data = result.data as { degraded: unknown[] };
      expect(data.degraded).toEqual([]);
      expect(result.text).not.toContain("could not check");
    });

    it("summarize appends the degradation warning to its rollup text", async () => {
      setInboxFetchers({
        gmail: async () => {
          throw new Error("HTTP 503 from Gmail");
        },
        discord: async () => [
          makeItem({ platform: "discord", id: "d-2", snippet: "hey" }),
        ],
      });
      const result = await callInbox(makeRuntime(), makeMessage(), {
        subaction: "summarize",
        platforms: ["gmail", "discord"],
      });
      expect(result.success).toBe(true);
      expect(result.text).toContain("Summarized 2 platforms");
      expect(result.text).toContain("could not check gmail");
      expect(result.text).toContain("HTTP 503 from Gmail");
    });
  });

  describe("triage queue operations", () => {
    it("lists persisted unresolved triage entries and hides snoozed rows by default", async () => {
      const { runtime, calls } = makeDbRuntime((sql) =>
        sql.includes("life_inbox_triage_entries")
          ? [makeTriageRow({ id: "entry-1" })]
          : [],
      );

      const result = await callInbox(runtime, makeMessage(), {
        subaction: "triage",
        limit: 5,
      });

      expect(result.success).toBe(true);
      expect(result.text).toContain("Loaded 1");
      const data = result.data as { entries: Array<{ id: string }> };
      expect(data.entries[0]?.id).toBe("entry-1");
      const select = calls[0]?.sql ?? "";
      expect(select).toContain("resolved = FALSE");
      expect(select).toContain("snoozed_until IS NULL");
      expect(select).toContain("LIMIT 5");
    });

    it("runs the triage classifier over fresh messages and persists one entry per message", async () => {
      setInboxFetchers({
        gmail: async () => [
          makeItem({
            platform: "gmail",
            id: "gmail-fresh-1",
            senderName: "Priya",
            snippet: "PROD IS DOWN — approve the rollback now",
            receivedAt: "2026-05-11T10:05:00.000Z",
          }),
          makeItem({
            platform: "gmail",
            id: "gmail-fresh-2",
            senderName: "ShoeDeals Weekly",
            snippet: "50% OFF SNEAKERS this weekend only",
            receivedAt: "2026-05-11T10:00:00.000Z",
          }),
        ],
      });
      // Full canonical ref in the core store for the first item — the
      // classifier input must carry the full body, not just the snippet.
      getDefaultTriageService()
        .getStore()
        .saveMessage({
          id: "gmail-fresh-1",
          source: "gmail",
          externalId: "gmail-fresh-1",
          from: { identifier: "priya@example.com", displayName: "Priya" },
          to: [{ identifier: "owner@example.com" }],
          snippet: "PROD IS DOWN — approve the rollback now",
          body: "PROD IS DOWN — checkout is returning 500s for every customer. Approve the emergency rollback right now.",
          receivedAtMs: Date.parse("2026-05-11T10:05:00.000Z"),
          hasAttachments: false,
          isRead: false,
        });

      const { runtime, calls } = makeDbRuntime((sql) => {
        if (sql.includes("SELECT source_message_id")) return [];
        if (sql.includes("WHERE source_message_id =")) return [];
        if (sql.includes("life_inbox_triage_examples")) return [];
        if (sql.startsWith("INSERT")) return [];
        return [makeTriageRow({ id: "entry-fresh-1" })];
      });
      const useModel = vi.fn(async (_type: string, _params: unknown) =>
        JSON.stringify({
          results: [
            {
              classification: "urgent",
              urgency: "high",
              confidence: 0.95,
              reasoning: "production outage",
              suggestedResponse: null,
            },
            {
              classification: "ignore",
              urgency: "low",
              confidence: 0.9,
              reasoning: "automated promotion",
              suggestedResponse: null,
            },
          ],
        }),
      );
      (runtime as { useModel?: unknown }).useModel = useModel;
      (runtime as { getService?: unknown }).getService = () => null;

      const result = await callInbox(runtime, makeMessage("triage my inbox"), {
        subaction: "triage",
        platforms: ["gmail"],
      });

      expect(result.success).toBe(true);
      expect(result.text).toContain("Triaged 2 new messages");
      expect(result.data).toMatchObject({ subaction: "triage", classified: 2 });

      // Exactly one classifier call, carrying the full stored body (not just
      // the fetched snippet) for the store-backed message.
      expect(useModel).toHaveBeenCalledTimes(1);
      const prompt = (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt;
      expect(prompt).toContain("Classify each message");
      expect(prompt).toContain("checkout is returning 500s for every customer");
      expect(prompt).toContain("50% OFF SNEAKERS");

      const inserts = calls.filter((call) => call.sql.startsWith("INSERT"));
      expect(inserts).toHaveLength(2);
      expect(inserts[0]?.sql).toContain("'urgent'");
      expect(inserts[1]?.sql).toContain("'ignore'");
    });

    it("classifies only messages without a persisted triage entry", async () => {
      setInboxFetchers({
        gmail: async () => [
          makeItem({
            platform: "gmail",
            id: "gmail-old-1",
            snippet: "already triaged",
            receivedAt: "2026-05-11T10:05:00.000Z",
          }),
          makeItem({
            platform: "gmail",
            id: "gmail-new-1",
            snippet: "brand new question about the launch",
            receivedAt: "2026-05-11T10:00:00.000Z",
          }),
        ],
      });

      const { runtime, calls } = makeDbRuntime((sql) => {
        if (sql.includes("SELECT source_message_id"))
          return [{ source_message_id: "gmail-old-1" }];
        if (sql.includes("WHERE source_message_id =")) return [];
        if (sql.includes("life_inbox_triage_examples")) return [];
        if (sql.startsWith("INSERT")) return [];
        return [makeTriageRow({ id: "entry-new-1" })];
      });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          results: [
            {
              classification: "needs_reply",
              urgency: "medium",
              confidence: 0.8,
              reasoning: "direct question",
              suggestedResponse: null,
            },
          ],
        }),
      );
      (runtime as { useModel?: unknown }).useModel = useModel;
      (runtime as { getService?: unknown }).getService = () => null;

      const result = await callInbox(runtime, makeMessage("triage my inbox"), {
        subaction: "triage",
        platforms: ["gmail"],
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ classified: 1 });
      expect(useModel).toHaveBeenCalledTimes(1);
      const prompt = (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt;
      expect(prompt).toContain("brand new question about the launch");
      expect(prompt).not.toContain("already triaged");
      expect(
        calls.filter((call) => call.sql.startsWith("INSERT")),
      ).toHaveLength(1);
    });

    it("classifies fresh messages before applying a classification-filtered queue read", async () => {
      const gmailFetcher = vi.fn(async () => [
        makeItem({
          platform: "gmail",
          id: "gmail-should-classify",
          snippet: "production is down and needs urgent review",
          receivedAt: "2026-05-11T10:00:00.000Z",
        }),
      ]);
      setInboxFetchers({ gmail: gmailFetcher });

      const { runtime, calls } = makeDbRuntime((sql) => {
        if (sql.includes("SELECT source_message_id")) return [];
        if (sql.includes("WHERE source_message_id =")) return [];
        if (sql.includes("life_inbox_triage_examples")) return [];
        if (sql.startsWith("INSERT")) return [];
        if (sql.includes("classification = ")) {
          return [
            makeTriageRow({ id: "entry-urgent-1", classification: "urgent" }),
          ];
        }
        return [];
      });
      const useModel = vi.fn(async () =>
        JSON.stringify({
          results: [
            {
              classification: "urgent",
              urgency: "high",
              confidence: 0.92,
              reasoning: "production outage",
              suggestedResponse: null,
            },
          ],
        }),
      );
      (runtime as { useModel?: unknown }).useModel = useModel;
      (runtime as { getService?: unknown }).getService = () => null;

      const result = await callInbox(
        runtime,
        makeMessage("show my urgent inbox items"),
        {
          subaction: "triage",
          platforms: ["gmail"],
          classification: "urgent",
        },
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ subaction: "triage", classified: 1 });
      expect(gmailFetcher).toHaveBeenCalledTimes(1);
      expect(useModel).toHaveBeenCalledTimes(1);
      const prompt = (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt;
      expect(prompt).toContain("production is down and needs urgent review");
      const select = calls.find((call) =>
        call.sql.includes("classification = "),
      )?.sql;
      expect(select).toContain("classification = ");
    });

    it("surfaces a classifier failure as an action failure instead of silently degrading", async () => {
      setInboxFetchers({
        gmail: async () => [
          makeItem({
            platform: "gmail",
            id: "gmail-fail-1",
            snippet: "will not classify",
            receivedAt: "2026-05-11T10:00:00.000Z",
          }),
        ],
      });

      const { runtime, calls } = makeDbRuntime((sql) => {
        if (sql.includes("SELECT source_message_id")) return [];
        if (sql.includes("life_inbox_triage_examples")) return [];
        return [];
      });
      (runtime as { useModel?: unknown }).useModel = vi.fn(async () => {
        throw new Error("model unavailable");
      });
      (runtime as { getService?: unknown }).getService = () => null;

      const result = await callInbox(runtime, makeMessage("triage my inbox"), {
        subaction: "triage",
        platforms: ["gmail"],
      });

      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "INBOX_OPERATION_FAILED" });
      expect(
        calls.filter((call) => call.sql.startsWith("INSERT")),
      ).toHaveLength(0);
    });

    it("snoozes a persisted triage entry until the provided timestamp", async () => {
      const { runtime, calls } = makeDbRuntime((sql) => {
        if (sql.startsWith("SELECT")) return [makeTriageRow({ id: "entry-1" })];
        return [];
      });

      const result = await callInbox(runtime, makeMessage(), {
        subaction: "snooze",
        entryId: "entry-1",
        until: "2026-07-02T00:00:00-04:00",
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        subaction: "snooze",
        entryId: "entry-1",
        snoozedUntil: "2026-07-02T04:00:00.000Z",
      });
      const update = calls.find((call) => call.sql.startsWith("UPDATE"));
      expect(update?.sql).toContain(
        "snoozed_until = '2026-07-02T04:00:00.000Z'",
      );
      expect(update?.sql).toContain("resolved = FALSE");
    });

    it("rejects an explicit malformed snooze timestamp instead of applying the default window", async () => {
      const { runtime, calls } = makeDbRuntime((sql) => {
        if (sql.startsWith("SELECT")) return [makeTriageRow({ id: "entry-1" })];
        return [];
      });

      const result = await callInbox(runtime, makeMessage(), {
        subaction: "snooze",
        entryId: "entry-1",
        snoozedUntil: 24 * 60 * 60 * 1000,
      } as unknown as InboxActionParameters);

      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "INBOX_OPERATION_FAILED" });
      expect(
        calls.filter((call) => call.sql.startsWith("UPDATE")),
      ).toHaveLength(0);
    });
  });

  // The marker builders themselves are pinned by inbox-choice-markers.test.ts;
  // these tests drive the REAL action handler end-to-end (repository + triage
  // adapter + callback) and assert the chips reach the chat reply with values
  // the next turn's handler accepts.
  describe("one-tap [CHOICE] chips through the handler (#14733)", () => {
    /**
     * Minimal real adapter registered on the default triage service so the
     * draft/send rail runs for real (create + send recorded); only the
     * connector transport is faked.
     */
    function registerFakeGmailAdapter(): {
      drafts: Array<{ body: string }>;
      sent: string[];
      archived: string[];
    } {
      const drafts: Array<{ body: string }> = [];
      const sent: string[] = [];
      const archived: string[] = [];
      let seq = 0;
      const adapter: MessageAdapter = {
        source: "gmail",
        isAvailable: () => true,
        capabilities: () => ({
          list: true,
          search: false,
          manage: { archive: true },
          send: { reply: true },
          worlds: "single",
          channels: "none",
        }),
        listMessages: async () => [],
        getMessage: async () => null,
        manageMessage: async (_runtime, messageId) => {
          archived.push(messageId);
          return { ok: true };
        },
        createDraft: async (_runtime, draft) => {
          drafts.push({ body: draft.body });
          seq += 1;
          return { draftId: `draft-${seq}`, preview: draft.body.slice(0, 40) };
        },
        sendDraft: async (_runtime, draftId) => {
          sent.push(draftId);
          return { externalId: `ext-${draftId}` };
        },
      };
      getDefaultTriageService().register(adapter);
      return { drafts, sent, archived };
    }

    function collectCallback(): {
      texts: string[];
      callback: (content: Content) => Promise<[]>;
    } {
      const texts: string[] = [];
      return {
        texts,
        callback: async (content: Content) => {
          if (typeof content.text === "string") texts.push(content.text);
          return [];
        },
      };
    }

    it("appends send/discard chips to a drafted-reply confirmation and keeps the values the approve turn accepts", async () => {
      registerFakeGmailAdapter();
      const { runtime } = makeDbRuntime((sql) =>
        sql.includes("WHERE id =") ? [makeTriageRow({ id: "entry-42" })] : [],
      );
      const { texts, callback } = collectCallback();

      const result = await inboxAction.handler(
        runtime,
        makeMessage("reply to alice that friday works"),
        undefined,
        {
          parameters: {
            subaction: "reply",
            entryId: "entry-42",
            body: "Yes, Friday works.",
          },
        } as unknown as HandlerOptions,
        callback as unknown as Parameters<typeof inboxAction.handler>[4],
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        subaction: "reply",
        requiresConfirmation: true,
        entryId: "entry-42",
      });
      // The chat reply (callback) and the planner-facing result text agree,
      // and both carry the structured block appended after the prose.
      expect(texts).toHaveLength(1);
      expect(result.text).toBe(texts[0]);
      expect(texts[0]).toContain("Confirm before sending");
      const { blocks } = parseInteractionBlocks(texts[0] ?? "");
      expect(blocks).toHaveLength(1);
      const block = blocks[0];
      expect(block).toMatchObject({
        kind: "choice",
        scope: "inbox-draft-entry-42",
        id: "entry-42",
      });
      if (block?.kind !== "choice") throw new Error("expected choice block");
      // Values carry the subaction token + entry id the next turn's handler
      // resolves ("inbox approve entry-42" → approve, entryId=entry-42);
      // every chip maps to an op the INBOX action actually supports.
      expect(block.options.map((o) => o.value)).toEqual([
        "inbox approve entry-42",
        "inbox archive entry-42",
      ]);
      expect(block.options.map((o) => o.label)).toEqual(["Send", "Discard"]);
    });

    it("a confirmed approve dispatches the stored draft and emits NO chips", async () => {
      const { sent } = registerFakeGmailAdapter();
      const { runtime } = makeDbRuntime((sql) =>
        sql.includes("WHERE id =")
          ? [makeTriageRow({ id: "entry-42", draft_response: "Yes, Friday." })]
          : [],
      );
      const { texts, callback } = collectCallback();

      const result = await inboxAction.handler(
        runtime,
        makeMessage("send"),
        undefined,
        {
          parameters: { subaction: "approve", entryId: "entry-42" },
        } as unknown as HandlerOptions,
        callback as unknown as Parameters<typeof inboxAction.handler>[4],
      );

      expect(result.success).toBe(true);
      expect(sent).toHaveLength(1);
      expect(texts[0]).toContain("Sent reply");
      expect(parseInteractionBlocks(texts[0] ?? "").blocks).toHaveLength(0);
    });

    it("appends per-thread reply/snooze/archive chips to the triage queue, capped at five threads, with entry ids in the values", async () => {
      const rows = ["e1", "e2", "e3", "e4", "e5", "e6"].map((id, index) =>
        makeTriageRow({
          id,
          sender_name: `Sender ${index + 1}`,
          snippet: `message ${index + 1}`,
        }),
      );
      const { runtime } = makeDbRuntime((sql) =>
        sql.includes("life_inbox_triage_entries") ? rows : [],
      );
      const { texts, callback } = collectCallback();

      const result = await inboxAction.handler(
        runtime,
        makeMessage("triage my inbox"),
        undefined,
        {
          parameters: { subaction: "triage", limit: 10 },
        } as unknown as HandlerOptions,
        callback as unknown as Parameters<typeof inboxAction.handler>[4],
      );

      expect(result.success).toBe(true);
      const text = texts[0] ?? "";
      const { blocks } = parseInteractionBlocks(text);
      expect(blocks).toHaveLength(5);
      blocks.forEach((block, index) => {
        const id = `e${index + 1}`;
        expect(block).toMatchObject({
          kind: "choice",
          scope: `inbox-thread-${id}`,
          id,
        });
        if (block.kind !== "choice") throw new Error("expected choice block");
        // Values embed the entry id: a tap round-trips only the value, and
        // with several blocks in one reply a bare "reply" is unattributable.
        expect(block.options.map((o) => o.value)).toEqual([
          `inbox reply ${id}`,
          `inbox snooze ${id}`,
          `inbox archive ${id}`,
        ]);
        // The reply chip names the sender so each block reads attributably.
        expect(block.options[0]?.label).toBe(`Reply to Sender ${index + 1}`);
      });
      expect(text).not.toContain("e6");
    });

    it("an archive chip value round-trips into a successful archive of that entry", async () => {
      const { archived } = registerFakeGmailAdapter();
      const { runtime } = makeDbRuntime((sql) =>
        sql.includes("WHERE id =") ? [makeTriageRow({ id: "e2" })] : [],
      );

      // The tapped value is `inbox archive e2`; the planner maps the tokens
      // to subaction + entryId. Drive the handler with exactly that mapping.
      const value = "inbox archive e2";
      const [, subaction, entryId] = value.split(" ");
      const result = await callInbox(runtime, makeMessage(value), {
        subaction,
        entryId,
      });

      expect(result.success).toBe(true);
      expect(archived).toEqual(["gmail-msg-1"]);
      expect(result.data).toMatchObject({
        subaction: "archive",
        entryId: "e2",
      });
    });

    it("a snooze chip value round-trips into a successful default snooze of that entry (#14735)", async () => {
      // The Snooze chip emitted by the triage grammar carries only
      // `inbox snooze <id>` (no timestamp — a tap has no free text to add and
      // the value must stay under the 64-byte connector cap). Before this fix
      // the snooze op threw "valid snooze timestamp is required", so the one
      // shipped Snooze affordance was a guaranteed error. A bare snooze tap
      // must now succeed with a sane default window instead of failing.
      const before = Date.now();
      const { runtime, calls } = makeDbRuntime((sql) =>
        sql.startsWith("SELECT") ? [makeTriageRow({ id: "e3" })] : [],
      );

      // The tapped value is exactly `inbox snooze e3`; the planner maps the
      // tokens to subaction + entryId with NO `until`/`snoozedUntil` param.
      const value = "inbox snooze e3";
      const [, subaction, entryId] = value.split(" ");
      const result = await callInbox(runtime, makeMessage(value), {
        subaction,
        entryId,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ subaction: "snooze", entryId: "e3" });

      const snoozedUntil = (result.data as { snoozedUntil?: string })
        .snoozedUntil;
      expect(typeof snoozedUntil).toBe("string");
      const untilMs = Date.parse(snoozedUntil ?? "");
      // Default window is ~24h out: safely in the future, and under two days.
      expect(untilMs).toBeGreaterThan(before + 20 * 60 * 60 * 1000);
      expect(untilMs).toBeLessThan(before + 48 * 60 * 60 * 1000);

      const update = calls.find((call) => call.sql.startsWith("UPDATE"));
      expect(update?.sql).toContain("snoozed_until = ");
      expect(update?.sql).toContain("resolved = FALSE");
    });
  });
});
