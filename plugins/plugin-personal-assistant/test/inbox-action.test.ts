/**
 * `INBOX` umbrella action — unit tests (W2-5).
 *
 * Wave-1 scaffold. Asserts the cross-channel inbox surface exists,
 * fans out across the configured platforms, dedupes by id + thread topic,
 * and respects the search / summarize subactions.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetInboxFetchersForTests,
  type InboxItem,
  inboxAction,
  setInboxFetchers,
} from "../src/actions/inbox.js";

// The action gates on the canonical owner via core's fail-closed
// `hasRoleAccess(runtime, message, "OWNER")` (#14931), which resolves the owner
// from the `ELIZA_ADMIN_ENTITY_ID` runtime setting. The harness registers
// OWNER_ENTITY_ID as that owner and sends messages from it so the OWNER gate
// passes; the deny path is exercised with a non-owner connector sender below.
const OWNER_ENTITY_ID = "owner-1" as UUID;

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-inbox-test" as UUID,
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY_ID : undefined,
    getRoom: async () => null,
    getWorld: async () => null,
    getEntityById: async () => null,
    getComponents: async () => [],
    getMemories: async () => [],
    getRelationships: async () => [],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(
  text = "show my inbox",
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id: "msg-inbox-1" as UUID,
    entityId: OWNER_ENTITY_ID,
    roomId: "room-inbox-1" as UUID,
    content: { text },
    ...overrides,
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

describe("INBOX umbrella action — cross-channel inbox", () => {
  beforeEach(() => {
    __resetInboxFetchersForTests();
  });

  describe("metadata", () => {
    it("exposes the canonical name and PRD similes", () => {
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

    it("rejects calls with no subaction selector", async () => {
      const result = await callInbox(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("rejects callers that fail the owner-access check", async () => {
      const nonOwnerMessage = makeMessage("show my inbox", {
        entityId: "guest-1" as UUID,
        content: { text: "show my inbox", source: "discord" },
      });
      const result = await callInbox(makeRuntime(), nonOwnerMessage, {
        subaction: "list",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
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
      expect(fetcherArgs.query).toBe("launch plan");
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
});
