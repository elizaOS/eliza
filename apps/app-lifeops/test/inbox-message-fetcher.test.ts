import type { IAgentRuntime, Memory, Room, UUID, World } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import {
  fetchChatMessages,
  fetchGmailMessages,
  fetchXDmMessages,
  type GmailInboxSource,
  type XDmInboxSource,
} from "../src/inbox/message-fetcher.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000004" as UUID;

type RuntimeSlice = Pick<
  IAgentRuntime,
  | "agentId"
  | "getRoomsForParticipant"
  | "getRoom"
  | "getMemoriesByRoomIds"
  | "getWorld"
>;

function makeRoom(): Room {
  return {
    id: ROOM_ID,
    name: "Telegram DM",
    source: "telegram",
    type: "dm",
    worldId: WORLD_ID,
    metadata: {},
  } as Room;
}

function makeMemory(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000005" as UUID,
    roomId: ROOM_ID,
    entityId: SENDER_ID,
    createdAt: Date.parse("2026-04-21T12:00:00Z"),
    content: {
      source: "telegram",
      text: "ship the cleanup",
    },
    metadata: {
      entityName: "Owner",
    },
  } as Memory;
}

function makeRuntime(overrides: Partial<RuntimeSlice> = {}): IAgentRuntime {
  const runtime: RuntimeSlice = {
    agentId: AGENT_ID,
    getRoomsForParticipant: vi.fn(async () => [ROOM_ID]),
    getRoom: vi.fn(async () => makeRoom()),
    getMemoriesByRoomIds: vi.fn(async () => [makeMemory()]),
    getWorld: vi.fn(async () => ({ id: WORLD_ID, metadata: {} }) as World),
    ...overrides,
  };
  return runtime as IAgentRuntime;
}

describe("fetchChatMessages", () => {
  test("propagates room lookup failures instead of dropping the room", async () => {
    const runtime = makeRuntime({
      getRoom: vi.fn(async () => {
        throw new Error("room store offline");
      }),
      getMemoriesByRoomIds: vi.fn(async () => []),
    });

    await expect(fetchChatMessages(runtime, {})).rejects.toThrow(
      "room store offline",
    );
    expect(runtime.getMemoriesByRoomIds).not.toHaveBeenCalled();
  });

  test("propagates world lookup failures instead of building partial deep-link metadata", async () => {
    const runtime = makeRuntime({
      getWorld: vi.fn(async () => {
        throw new Error("world store offline");
      }),
    });

    await expect(fetchChatMessages(runtime, {})).rejects.toThrow(
      "world store offline",
    );
  });
});

describe("fetchGmailMessages", () => {
  test("passes the requested limit through to Gmail triage for cache warming", async () => {
    const source: GmailInboxSource = {
      getGoogleConnectorStatus: vi.fn(async () => ({
        provider: "google",
        side: "owner",
        mode: "oauth",
        defaultMode: "oauth",
        availableModes: ["oauth"],
        executionTarget: "local",
        sourceOfTruth: "local_storage",
        configured: true,
        connected: true,
        reason: "connected",
        grantedCapabilities: ["google.gmail.triage"],
        missingCapabilities: [],
        identity: null,
        authUrl: null,
      })),
      getGmailTriage: vi.fn(async () => ({
        messages: [],
        source: "cache",
        syncedAt: null,
        summary: {
          totalCount: 0,
          unreadCount: 0,
          importantCount: 0,
          replyNeededCount: 0,
        },
      })),
    };

    await fetchGmailMessages(source, { limit: 1200, grantId: "grant-1" });

    expect(source.getGmailTriage).toHaveBeenCalledWith(
      expect.any(URL),
      { grantId: "grant-1", maxResults: 1200 },
    );
  });
});

describe("fetchXDmMessages", () => {
  test("preserves read and replied timestamps for inbox missed-state checks", async () => {
    const source: XDmInboxSource = {
      getXConnectorStatus: vi.fn(async () => ({
        provider: "x",
        side: "owner",
        mode: "cloud_managed",
        defaultMode: "cloud_managed",
        availableModes: ["cloud_managed"],
        executionTarget: "cloud",
        sourceOfTruth: "cloud",
        configured: true,
        connected: true,
        reason: "connected",
        grantedCapabilities: [],
        grantedScopes: [],
        missingCapabilities: [],
        identity: null,
        hasCredentials: true,
        grant: null,
        dmRead: true,
        dmWrite: true,
        dmInbound: true,
        feedRead: false,
        feedWrite: false,
      })),
      syncXDms: vi.fn(async () => ({ synced: 1 })),
      getXDms: vi.fn(async () => [
        {
          id: "dm-1",
          agentId: String(AGENT_ID),
          externalDmId: "external-dm-1",
          conversationId: "conversation-1",
          senderHandle: "sender",
          senderId: "sender-id",
          isInbound: true,
          text: "checking in",
          receivedAt: "2026-04-21T12:00:00.000Z",
          readAt: "2026-04-21T12:05:00.000Z",
          repliedAt: "2026-04-21T12:10:00.000Z",
          metadata: {},
          syncedAt: "2026-04-21T12:11:00.000Z",
          updatedAt: "2026-04-21T12:11:00.000Z",
        },
      ]),
    };

    const messages = await fetchXDmMessages(source, { limit: 10 });

    expect(messages[0]?.lastSeenAt).toBe("2026-04-21T12:05:00.000Z");
    expect(messages[0]?.repliedAt).toBe("2026-04-21T12:10:00.000Z");
  });
});
