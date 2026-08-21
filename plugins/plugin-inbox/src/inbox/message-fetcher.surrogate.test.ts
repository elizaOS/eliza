/**
 * Message-fetcher surrogate safety — thread context (100) and inbox snippets
 * (200) for chat, Gmail, and X DM paths. Exercises exported formatters and
 * the real fetchers with emoji fixtures so reverting any slice site to naive
 * `.slice(0, N)` makes the suite red.
 */

import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  fetchChatMessages,
  fetchGmailMessages,
  fetchXDmMessages,
  formatChatSnippet,
  formatGmailSnippet,
  formatInboxSnippet,
  formatThreadPreview,
  formatXDmSnippet,
  INBOX_SNIPPET_MAX_LENGTH,
  THREAD_PREVIEW_MAX_LENGTH,
} from "./message-fetcher.js";

const R = "🦊";

function isWellFormed(value: string): boolean {
  const w = value as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertWellFormedAndJsonSafe(value: string, cap: number): void {
  expect(isWellFormed(value)).toBe(true);
  expect(value.length).toBeLessThanOrEqual(cap);
  expect(() => JSON.stringify({ value })).not.toThrow();
  const parsed = JSON.parse(JSON.stringify({ value })) as { value: string };
  expect(isWellFormed(parsed.value)).toBe(true);
}

describe("message-fetcher exported formatters — mutation-proof", () => {
  it("thread preview backs off mid-pair at 100 via formatThreadPreview", () => {
    const out = formatThreadPreview(`${"a".repeat(99)}${R}b`);
    assertWellFormedAndJsonSafe(out, THREAD_PREVIEW_MAX_LENGTH);
    expect(out.length).toBe(99);
    expect(out).toBe("a".repeat(99));
  });

  it("chat snippet backs off mid-pair at 200 via formatChatSnippet", () => {
    const out = formatChatSnippet(`${"a".repeat(199)}${R}b`);
    assertWellFormedAndJsonSafe(out, INBOX_SNIPPET_MAX_LENGTH);
    expect(out.length).toBe(199);
  });

  it("gmail snippet backs off mid-pair at 200 via formatGmailSnippet", () => {
    const out = formatGmailSnippet(`${"a".repeat(199)}${R}b`);
    assertWellFormedAndJsonSafe(out, INBOX_SNIPPET_MAX_LENGTH);
    expect(out.length).toBe(199);
  });

  it("xDm snippet backs off mid-pair at 200 via formatXDmSnippet", () => {
    const out = formatXDmSnippet(`${"a".repeat(199)}${R}b`);
    assertWellFormedAndJsonSafe(out, INBOX_SNIPPET_MAX_LENGTH);
    expect(out.length).toBe(199);
  });

  it("formatInboxSnippet alias backs off at 200", () => {
    const out = formatInboxSnippet(`${"a".repeat(199)}${R}b`);
    assertWellFormedAndJsonSafe(out, INBOX_SNIPPET_MAX_LENGTH);
    expect(out.length).toBe(199);
  });

  it("preserves fitting emoji at both caps", () => {
    expect(formatThreadPreview(`${"a".repeat(98)}${R}`)).toBe(
      `${"a".repeat(98)}${R}`,
    );
    expect(formatChatSnippet(`${"a".repeat(198)}${R}`)).toBe(
      `${"a".repeat(198)}${R}`,
    );
    expect(formatGmailSnippet(`${"a".repeat(198)}${R}`)).toBe(
      `${"a".repeat(198)}${R}`,
    );
    expect(formatXDmSnippet(`${"a".repeat(198)}${R}`)).toBe(
      `${"a".repeat(198)}${R}`,
    );
    assertWellFormedAndJsonSafe(
      formatThreadPreview(`${"a".repeat(98)}${R}`),
      THREAD_PREVIEW_MAX_LENGTH,
    );
    assertWellFormedAndJsonSafe(
      formatChatSnippet(`${"a".repeat(198)}${R}`),
      INBOX_SNIPPET_MAX_LENGTH,
    );
  });

  it("sweep 0..65 at 100 and 200 stays well-formed and JSON-safe", () => {
    for (let off = 0; off <= 65; off++) {
      assertWellFormedAndJsonSafe(
        formatThreadPreview(`${"a".repeat(off)}${R}${"b".repeat(250)}`),
        THREAD_PREVIEW_MAX_LENGTH,
      );
      assertWellFormedAndJsonSafe(
        formatChatSnippet(`${"a".repeat(off)}${R}${"b".repeat(300)}`),
        INBOX_SNIPPET_MAX_LENGTH,
      );
      assertWellFormedAndJsonSafe(
        formatGmailSnippet(`${"a".repeat(off)}${R}${"b".repeat(300)}`),
        INBOX_SNIPPET_MAX_LENGTH,
      );
      assertWellFormedAndJsonSafe(
        formatXDmSnippet(`${"a".repeat(off)}${R}${"b".repeat(300)}`),
        INBOX_SNIPPET_MAX_LENGTH,
      );
    }
  });

  it("sanitises lone surrogate via formatter", () => {
    const out = formatInboxSnippet(`ok \ud83d ${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("thread line via formatter stays well-formed and JSON-safe", () => {
    const name = "Alice";
    const txt = `${"a".repeat(99)}${R}b`;
    const line = `${name}: ${formatThreadPreview(txt)}`;
    assertWellFormedAndJsonSafe(
      line,
      name.length + 2 + THREAD_PREVIEW_MAX_LENGTH,
    );
  });
});

describe("fetchGmailMessages — snippet surrogate safety via real fetcher", () => {
  it("gmail snippet at 199+emoji backs off and stays JSON-safe", async () => {
    const gmailSource = {
      getGoogleConnectorStatus: async () => ({
        provider: "google",
        side: "owner",
        mode: "cloud",
        defaultMode: "cloud",
        availableModes: ["cloud"],
        executionTarget: "cloud",
        sourceOfTruth: "cloud",
        configured: true,
        connected: true,
        reason: "connected",
        preferredByAgent: true,
        cloudConnectionId: "test",
        identity: null,
        grantedCapabilities: ["google.gmail.triage"],
        grantedScopes: [],
        expiresAt: null,
        hasRefreshToken: true,
        grant: null,
      }),
      getGmailTriage: async () => ({
        messages: [
          {
            id: "g1",
            externalId: "ext1",
            agentId: "agent1",
            provider: "google",
            side: "owner",
            threadId: "t1",
            subject: "hello",
            from: "bob@example.com",
            fromEmail: "bob@example.com",
            replyTo: null,
            to: ["owner@example.com"],
            cc: [],
            snippet: `${"a".repeat(199)}${R}b`,
            receivedAt: new Date().toISOString(),
            isUnread: true,
            isImportant: false,
            likelyReplyNeeded: false,
            triageScore: 0,
            triageReason: "",
            labels: [],
            htmlLink: null,
            metadata: {},
            syncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            grantId: "grant1",
            accountEmail: "owner@example.com",
          },
        ],
      }),
    } as unknown as import("./message-fetcher.js").GmailInboxSource;

    const result = await fetchGmailMessages(gmailSource, { limit: 10 });
    expect(result.messages).toHaveLength(1);
    const snippet = result.messages[0]?.snippet;
    assertWellFormedAndJsonSafe(snippet, INBOX_SNIPPET_MAX_LENGTH);
    expect(snippet.length).toBe(199);
    expect(isWellFormed(snippet)).toBe(true);
  });

  it("gmail snippet sweep via fetcher stays well-formed", async () => {
    for (let off = 0; off <= 20; off++) {
      const snippetInput = `${"a".repeat(off)}${R}${"b".repeat(300)}`;
      const gmailSource = {
        getGoogleConnectorStatus: async () => ({
          provider: "google",
          side: "owner",
          mode: "cloud",
          defaultMode: "cloud",
          availableModes: ["cloud"],
          executionTarget: "cloud",
          sourceOfTruth: "cloud",
          configured: true,
          connected: true,
          reason: "connected",
          preferredByAgent: true,
          cloudConnectionId: "test",
          identity: null,
          grantedCapabilities: ["google.gmail.triage"],
          grantedScopes: [],
          expiresAt: null,
          hasRefreshToken: true,
          grant: null,
        }),
        getGmailTriage: async () => ({
          messages: [
            {
              id: `g-${off}`,
              externalId: `ext-${off}`,
              agentId: "agent1",
              provider: "google",
              side: "owner",
              threadId: "t1",
              subject: "hi",
              from: "bob@example.com",
              fromEmail: "bob@example.com",
              replyTo: null,
              to: ["owner@example.com"],
              cc: [],
              snippet: snippetInput,
              receivedAt: new Date().toISOString(),
              isUnread: true,
              isImportant: false,
              likelyReplyNeeded: false,
              triageScore: 0,
              triageReason: "",
              labels: [],
              htmlLink: null,
              metadata: {},
              syncedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              grantId: "grant1",
              accountEmail: "owner@example.com",
            },
          ],
        }),
      } as unknown as import("./message-fetcher.js").GmailInboxSource;
      const result = await fetchGmailMessages(gmailSource, { limit: 5 });
      assertWellFormedAndJsonSafe(
        result.messages[0]?.snippet,
        INBOX_SNIPPET_MAX_LENGTH,
      );
    }
  });
});

describe("fetchXDmMessages — snippet surrogate safety via real fetcher", () => {
  it("xDm snippet at 199+emoji backs off and stays JSON-safe", async () => {
    const xSource = {
      getXConnectorStatus: async () => ({
        provider: "x",
        connected: true,
        grantedCapabilities: ["x.dm.read"],
        grantedScopes: [],
        identity: null,
        hasCredentials: true,
        feedRead: true,
        feedWrite: true,
        dmRead: true,
        dmWrite: true,
        mode: "cloud",
        reason: "connected",
      }),
      syncXDms: async () => ({ synced: 1 }),
      getXDms: async () => [
        {
          id: "dm1",
          agentId: "agent1",
          externalDmId: "ext1",
          conversationId: "conv1",
          senderHandle: "bob",
          senderId: "sender1",
          isInbound: true,
          text: `${"a".repeat(199)}${R}b`,
          receivedAt: new Date().toISOString(),
          readAt: null,
          repliedAt: null,
          metadata: {},
          syncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    } as unknown as import("./message-fetcher.js").XDmInboxSource;

    const result = await fetchXDmMessages(xSource, { limit: 10 });
    expect(result.messages).toHaveLength(1);
    assertWellFormedAndJsonSafe(
      result.messages[0]?.snippet,
      INBOX_SNIPPET_MAX_LENGTH,
    );
    expect(result.messages[0]?.snippet.length).toBe(199);
  });

  it("xDm snippet sweep via fetcher stays well-formed", async () => {
    for (let off = 0; off <= 20; off++) {
      const text = `${"a".repeat(off)}${R}${"b".repeat(300)}`;
      const xSource = {
        getXConnectorStatus: async () => ({
          provider: "x",
          connected: true,
          grantedCapabilities: ["x.dm.read"],
          grantedScopes: [],
          identity: null,
          hasCredentials: true,
          feedRead: true,
          feedWrite: true,
          dmRead: true,
          dmWrite: true,
          mode: "cloud",
          reason: "connected",
        }),
        syncXDms: async () => ({ synced: 1 }),
        getXDms: async () => [
          {
            id: `dm-${off}`,
            agentId: "agent1",
            externalDmId: `ext-${off}`,
            conversationId: "conv1",
            senderHandle: "bob",
            senderId: "sender1",
            isInbound: true,
            text,
            receivedAt: new Date().toISOString(),
            readAt: null,
            repliedAt: null,
            metadata: {},
            syncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      } as unknown as import("./message-fetcher.js").XDmInboxSource;
      const result = await fetchXDmMessages(xSource, { limit: 5 });
      assertWellFormedAndJsonSafe(
        result.messages[0]?.snippet,
        INBOX_SNIPPET_MAX_LENGTH,
      );
    }
  });
});

describe("fetchChatMessages — thread context (100) and snippet (200) via real fetcher", () => {
  const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
  const ROOM_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;
  const OTHER_ENTITY = "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID;

  function makeMemory(
    overrides: Partial<Memory> & {
      text: string;
      id: string;
      createdAt: string;
      roomId?: string;
    },
  ): Memory {
    return {
      id: overrides.id,
      roomId: overrides.roomId ?? ROOM_ID,
      entityId: OTHER_ENTITY,
      createdAt: Date.parse(overrides.createdAt),
      content: { text: overrides.text, source: "discord" },
      metadata: { entityName: "Alice" },
      ...overrides,
    } as unknown as Memory;
  }

  it("chat snippet and thread context both stay well-formed and JSON-safe", async () => {
    const threadText = `${"a".repeat(99)}${R}b`; // would split at 100
    const mainText = `${"a".repeat(199)}${R}b`; // would split at 200
    const now = Date.now();
    const memories = [
      makeMemory({
        id: "m1",
        text: mainText,
        createdAt: new Date(now).toISOString(),
      }),
      makeMemory({
        id: "m2",
        text: threadText,
        createdAt: new Date(now - 1000).toISOString(),
      }),
    ];

    const runtime = {
      agentId: AGENT_ID,
      getRoomsForParticipant: async () => [ROOM_ID],
      getRoom: async () =>
        ({
          id: ROOM_ID,
          name: "general",
          source: "discord",
          type: "dm",
        }) as unknown as Room,
      getWorld: async () => null,
      getMemoriesByRoomIds: async () => memories,
      getParticipantsForRoom: async () =>
        [AGENT_ID, OTHER_ENTITY] as unknown as UUID[],
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, { limit: 10 });
    expect(messages.length).toBeGreaterThan(0);
    const msg = messages.find((m) => m.id === "m1");
    if (!msg) throw new Error("expected m1");
    assertWellFormedAndJsonSafe(msg.snippet, INBOX_SNIPPET_MAX_LENGTH);
    expect(msg.snippet.length).toBe(199);
    // threadMessages contains "Alice: <preview>" where preview is 100-capped
    const threadEntry = msg.threadMessages?.[0] ?? "";
    expect(threadEntry).toContain("Alice: ");
    const previewPart = threadEntry.slice("Alice: ".length);
    assertWellFormedAndJsonSafe(previewPart, THREAD_PREVIEW_MAX_LENGTH);
    expect(previewPart.length).toBe(99);
    expect(threadEntry.length).toBeLessThanOrEqual(
      "Alice: ".length + THREAD_PREVIEW_MAX_LENGTH,
    );
    expect(isWellFormed(threadEntry)).toBe(true);
    expect(() =>
      JSON.stringify({ threadMessages: msg.threadMessages }),
    ).not.toThrow();
  });

  it("chat snippet sweep via fetcher stays well-formed", async () => {
    const now = Date.now();
    for (let off = 0; off <= 10; off++) {
      const text = `${"a".repeat(off)}${R}${"b".repeat(300)}`;
      const memories = [
        makeMemory({
          id: `m-${off}`,
          text,
          createdAt: new Date(now).toISOString(),
        }),
      ];
      const runtime = {
        agentId: AGENT_ID,
        getRoomsForParticipant: async () => [ROOM_ID],
        getRoom: async () =>
          ({
            id: ROOM_ID,
            name: "general",
            source: "discord",
            type: "dm",
          }) as unknown as Room,
        getWorld: async () => null,
        getMemoriesByRoomIds: async () => memories,
        getParticipantsForRoom: async () =>
          [AGENT_ID, OTHER_ENTITY] as unknown as UUID[],
      } as unknown as IAgentRuntime;
      const messages = await fetchChatMessages(runtime, { limit: 5 });
      assertWellFormedAndJsonSafe(
        messages[0]?.snippet,
        INBOX_SNIPPET_MAX_LENGTH,
      );
    }
  });
});
