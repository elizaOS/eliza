/**
 * Exercises the inbox compatibility entrypoint with an explicit owner identity.
 * The real action handles allowed fan-out, denied callers and missing operations;
 * the inbox plugin owns domain transformations and controlled connector failures.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";

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

describe("INBOX compatibility entrypoint", () => {
  beforeEach(() => {
    __resetInboxFetchersForTests();
  });

  describe("admission", () => {
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
  });
});
