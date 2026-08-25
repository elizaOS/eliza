/**
 * Deterministic coverage for the admin-panel provider. The provider is real;
 * admin-access and canonical-owner helpers are mocked at their import
 * boundary so room filtering, newest-first fetch, oldest-first render,
 * sender labels, and createdAt / text fallbacks can be asserted without a
 * database.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasAdminAccess, resolveCanonicalOwnerIdForMessage } = vi.hoisted(
  () => ({
    hasAdminAccess:
      vi.fn<(runtime: IAgentRuntime, message: Memory) => Promise<boolean>>(),
    resolveCanonicalOwnerIdForMessage:
      vi.fn<
        (runtime: IAgentRuntime, message: Memory) => Promise<string | null>
      >(),
  }),
);

vi.mock("../security/access.ts", () => ({
  hasAdminAccess,
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    resolveCanonicalOwnerIdForMessage,
  };
});

const { MESSAGE_SOURCE_CLIENT_CHAT } = await import("@elizaos/core");
const { adminPanelProvider, createAdminPanelProvider } = await import(
  "./admin-panel.ts"
);

const ROOM_CHAT_A = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_CHAT_B = "00000000-0000-0000-0000-0000000000c2" as UUID;
const ROOM_DISCORD = "00000000-0000-0000-0000-0000000000c3" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000e0" as UUID;
const OTHER_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-0000000000f0" as UUID;
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };
const EMPTY_RESULT = {
  text: "",
  values: { hasAdminChat: false },
  data: { messageCount: 0 },
};

function turn(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000a1" as UUID,
    entityId: OWNER_ID,
    roomId: ROOM_CHAT_A,
    content: { text: "open admin" },
    createdAt: 1,
  } as Memory;
}

function chatMemory(params: {
  id: string;
  entityId: UUID;
  roomId: UUID;
  text: unknown;
  createdAt?: unknown;
}): Memory {
  return {
    id: params.id as UUID,
    entityId: params.entityId,
    roomId: params.roomId,
    content: { text: params.text },
    ...("createdAt" in params ? { createdAt: params.createdAt } : {}),
  } as Memory;
}

function makeRuntime(overrides: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getRoomsForParticipant: vi.fn(async () => [] as UUID[]),
    getRoom: vi.fn(async () => null),
    getMemoriesByRoomIds: vi.fn(async () => [] as Memory[]),
    reportError: vi.fn(),
    ...overrides,
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  vi.clearAllMocks();
  hasAdminAccess.mockResolvedValue(true);
  resolveCanonicalOwnerIdForMessage.mockResolvedValue(OWNER_ID);
});

describe("createAdminPanelProvider", () => {
  it("registers as an ADMIN-gated admin/settings provider", () => {
    const provider = createAdminPanelProvider();
    expect(provider.name).toBe("adminPanel");
    expect(provider.description).toBe(
      "Surfaces the owner's recent Eliza app chat so the agent has context across platforms.",
    );
    expect(provider.descriptionCompressed).toBe(
      "surface owner recent Eliza app chat agent context across platform",
    );
    expect(provider.dynamic).toBe(true);
    expect(provider.position).toBe(14);
    expect(provider.contexts).toEqual(["admin", "settings"]);
    expect(provider.contextGate).toEqual({ anyOf: ["admin", "settings"] });
    expect(provider.cacheStable).toBe(false);
    expect(provider.cacheScope).toBe("turn");
    expect(provider.roleGate).toEqual({ minRole: "ADMIN" });
  });

  it("returns a distinct instance from the module singleton", () => {
    const provider = createAdminPanelProvider();
    expect(provider).not.toBe(adminPanelProvider);
    expect(adminPanelProvider.name).toBe("adminPanel");
    expect(adminPanelProvider.position).toBe(14);
  });
});

describe("adminPanelProvider.get", () => {
  it("returns the empty result and skips owner resolution when the caller is not admin", async () => {
    hasAdminAccess.mockResolvedValue(false);
    const runtime = makeRuntime();

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result).toEqual(EMPTY_RESULT);
    expect(resolveCanonicalOwnerIdForMessage).not.toHaveBeenCalled();
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("returns the empty result when admin access is granted but no canonical owner exists", async () => {
    resolveCanonicalOwnerIdForMessage.mockResolvedValue(null);
    const runtime = makeRuntime();
    const message = turn();

    const result = await adminPanelProvider.get(runtime, message, EMPTY_STATE);

    expect(hasAdminAccess).toHaveBeenCalledWith(runtime, message);
    expect(resolveCanonicalOwnerIdForMessage).toHaveBeenCalledWith(
      runtime,
      message,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("treats an empty-string owner id as missing and skips room lookup", async () => {
    resolveCanonicalOwnerIdForMessage.mockResolvedValue("");
    const runtime = makeRuntime();

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result).toEqual(EMPTY_RESULT);
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("returns the empty result for an owner with no rooms", async () => {
    const getRoomsForParticipant = vi.fn(async () => [] as UUID[]);
    const runtime = makeRuntime({ getRoomsForParticipant });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(getRoomsForParticipant).toHaveBeenCalledWith(OWNER_ID);
    expect(runtime.getRoom).not.toHaveBeenCalled();
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("ignores missing rooms and non-client_chat sources and does not load memories", async () => {
    const getRoomsForParticipant = vi.fn(async () => [
      ROOM_CHAT_A,
      ROOM_DISCORD,
      ROOM_CHAT_B,
    ]);
    const getRoom = vi.fn(async (id: UUID) => {
      if (id === ROOM_CHAT_A) return null;
      if (id === ROOM_DISCORD) {
        return { id: ROOM_DISCORD, source: "discord" };
      }
      return { id: ROOM_CHAT_B, source: "telegram" };
    });
    const getMemoriesByRoomIds = vi.fn(async () => [
      chatMemory({
        id: "00000000-0000-0000-0000-0000000000a2",
        entityId: OWNER_ID,
        roomId: ROOM_DISCORD,
        text: "should not surface",
        createdAt: 10,
      }),
    ]);
    const runtime = makeRuntime({
      getRoomsForParticipant,
      getRoom,
      getMemoriesByRoomIds,
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(getRoom).toHaveBeenCalledTimes(3);
    expect(getMemoriesByRoomIds).not.toHaveBeenCalled();
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("loads memories only from client_chat rooms, including when mixed with null and other sources", async () => {
    const getRoomsForParticipant = vi.fn(async () => [
      ROOM_DISCORD,
      ROOM_CHAT_A,
      ROOM_CHAT_B,
    ]);
    const getRoom = vi.fn(async (id: UUID) => {
      if (id === ROOM_DISCORD) {
        return { id: ROOM_DISCORD, source: "discord" };
      }
      if (id === ROOM_CHAT_A) {
        return { id: ROOM_CHAT_A, source: MESSAGE_SOURCE_CLIENT_CHAT };
      }
      if (id === ROOM_CHAT_B) {
        return { id: ROOM_CHAT_B, source: MESSAGE_SOURCE_CLIENT_CHAT };
      }
      return null;
    });
    const getMemoriesByRoomIds = vi.fn(async () => [] as Memory[]);
    const runtime = makeRuntime({
      getRoomsForParticipant,
      getRoom,
      getMemoriesByRoomIds,
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(getMemoriesByRoomIds).toHaveBeenCalledWith({
      tableName: "messages",
      roomIds: [ROOM_CHAT_A, ROOM_CHAT_B],
    });
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("renders a single owner message oldest-first with hasAdminChat true", async () => {
    const runtime = makeRuntime({
      getRoomsForParticipant: vi.fn(async () => [ROOM_CHAT_A]),
      getRoom: vi.fn(async () => ({
        id: ROOM_CHAT_A,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      })),
      getMemoriesByRoomIds: vi.fn(async () => [
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a2",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "only one",
          createdAt: 42,
        }),
      ]),
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result.values).toEqual({ hasAdminChat: true });
    expect(result.data).toEqual({ messageCount: 1 });
    expect(result.text).toBe(
      "# Recent Owner Conversation (Eliza App)\n[Owner] only one",
    );
  });

  it("sorts newest-first then displays oldest-first across rooms", async () => {
    const runtime = makeRuntime({
      getRoomsForParticipant: vi.fn(async () => [ROOM_CHAT_A, ROOM_CHAT_B]),
      getRoom: vi.fn(async (id: UUID) => ({
        id,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      })),
      getMemoriesByRoomIds: vi.fn(async () => [
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a3",
          entityId: AGENT_ID,
          roomId: ROOM_CHAT_B,
          text: "agent later",
          createdAt: 30,
        }),
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a2",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "owner first",
          createdAt: 10,
        }),
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a4",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "owner middle",
          createdAt: 20,
        }),
      ]),
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result.data).toEqual({ messageCount: 3 });
    expect(result.values).toEqual({ hasAdminChat: true });
    expect(result.text).toBe(
      [
        "# Recent Owner Conversation (Eliza App)",
        "[Owner] owner first",
        "[Owner] owner middle",
        "[Agent] agent later",
      ].join("\n"),
    );
  });

  it("treats missing and non-number createdAt as 0 and keeps equal timestamps in reverse input order", async () => {
    const runtime = makeRuntime({
      getRoomsForParticipant: vi.fn(async () => [ROOM_CHAT_A]),
      getRoom: vi.fn(async () => ({
        id: ROOM_CHAT_A,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      })),
      getMemoriesByRoomIds: vi.fn(async () => [
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a2",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "tied-first",
          createdAt: 5,
        }),
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a3",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "tied-second",
          createdAt: 5,
        }),
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a4",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "missing-createdAt",
        }),
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a5",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "string-createdAt",
          createdAt: "99",
        }),
      ]),
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result.data).toEqual({ messageCount: 4 });
    expect(result.text).toBe(
      [
        "# Recent Owner Conversation (Eliza App)",
        "[Owner] string-createdAt",
        "[Owner] missing-createdAt",
        "[Owner] tied-second",
        "[Owner] tied-first",
      ].join("\n"),
    );
  });

  it("renders empty sender text when content.text is missing or not a string, and labels non-agent senders as Owner", async () => {
    const runtime = makeRuntime({
      getRoomsForParticipant: vi.fn(async () => [ROOM_CHAT_A]),
      getRoom: vi.fn(async () => ({
        id: ROOM_CHAT_A,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      })),
      getMemoriesByRoomIds: vi.fn(async () => [
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a2",
          entityId: OTHER_ID,
          roomId: ROOM_CHAT_A,
          text: 123,
          createdAt: 1,
        }),
        {
          id: "00000000-0000-0000-0000-0000000000a3" as UUID,
          entityId: AGENT_ID,
          roomId: ROOM_CHAT_A,
          content: {},
          createdAt: 2,
        } as Memory,
      ]),
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result.data).toEqual({ messageCount: 2 });
    expect(result.text).toBe(
      "# Recent Owner Conversation (Eliza App)\n[Owner] \n[Agent] ",
    );
  });

  it("still counts blank owner text as present chat context", async () => {
    const runtime = makeRuntime({
      getRoomsForParticipant: vi.fn(async () => [ROOM_CHAT_A]),
      getRoom: vi.fn(async () => ({
        id: ROOM_CHAT_A,
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      })),
      getMemoriesByRoomIds: vi.fn(async () => [
        chatMemory({
          id: "00000000-0000-0000-0000-0000000000a2",
          entityId: OWNER_ID,
          roomId: ROOM_CHAT_A,
          text: "",
          createdAt: 7,
        }),
      ]),
    });

    const result = await adminPanelProvider.get(runtime, turn(), EMPTY_STATE);

    expect(result.values).toEqual({ hasAdminChat: true });
    expect(result.data).toEqual({ messageCount: 1 });
    expect(result.text).toBe(
      "# Recent Owner Conversation (Eliza App)\n[Owner] ",
    );
  });
});
