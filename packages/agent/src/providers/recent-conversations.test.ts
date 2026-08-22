/**
 * Deterministic coverage for recent cross-platform context disclosure. The
 * provider is real; identity-cluster and audience-security helpers are mocked
 * at their core boundary so room expansion, batching, completeness, and denial
 * can be asserted without a database or authenticated delivery transport.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getVerifiedRelatedEntityIds =
  vi.fn<(runtime: IAgentRuntime, entityId: UUID) => Promise<UUID[]>>();
const revalidateOwnerExclusiveDisclosure = vi.fn(
  async (): Promise<Record<string, unknown>> => ({
    allowed: true,
    basis: "owner_private_destination",
  }),
);
const recordOwnerExclusiveSuppression = vi.fn();
const markOwnerExclusiveDisclosureUsed = vi.fn();

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    getVerifiedRelatedEntityIds,
    revalidateOwnerExclusiveDisclosure,
    recordOwnerExclusiveSuppression,
    markOwnerExclusiveDisclosureUsed,
  };
});

const { recentConversationsProvider } = await import(
  "./recent-conversations.ts"
);

const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ALIAS_ROOM_ID = "00000000-0000-0000-0000-0000000000c2" as UUID;
const REQUESTER_ONLY_ROOM_ID = "00000000-0000-0000-0000-0000000000c3" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000000e0" as UUID;
const ALIAS_ENTITY_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-0000000000f0" as UUID;
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000a1" as UUID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    content: { text: "hello there" },
    createdAt: 2,
  } as Memory;
}

function makeRuntime(overrides: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Test Agent" },
    getRoom: vi.fn(async () => ({
      id: ROOM_ID,
      source: "discord",
      name: "general",
    })),
    getRoomsForParticipants: vi.fn(async () => [ROOM_ID]),
    getRoomsForParticipant: vi.fn(async () => [ROOM_ID]),
    getMemoriesByRoomIds: vi.fn(async () => [
      { ...message(), createdAt: Number.POSITIVE_INFINITY },
    ]),
    getRoomsByIds: vi.fn(async () => [
      { id: ROOM_ID, source: "discord", name: "general" },
    ]),
    reportError: vi.fn(),
    ...overrides,
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  vi.clearAllMocks();
  getVerifiedRelatedEntityIds.mockResolvedValue([ENTITY_ID]);
  revalidateOwnerExclusiveDisclosure.mockResolvedValue({
    allowed: true,
    basis: "owner_private_destination",
  });
});

describe("recentConversationsProvider", () => {
  it("is always present during response routing so cross-world recall can answer directly", () => {
    expect(recentConversationsProvider.alwaysInResponseState).toBe(true);
  });

  it("omits empty age labels and their parentheses from provider output", async () => {
    const runtime = makeRuntime();

    const result = await recentConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(result.text).toContain("[discord] general user: hello there");
    expect(result.text).not.toContain("()");
    expect(result.text).not.toContain("NaN");
    expect(markOwnerExclusiveDisclosureUsed).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: ENTITY_ID }),
    );
  });

  it("expands linked aliases, dedupes rooms, batches tags, and retains every eligible message", async () => {
    getVerifiedRelatedEntityIds.mockResolvedValue([ENTITY_ID, ALIAS_ENTITY_ID]);
    const completeTexts = Array.from(
      { length: 15 },
      (_, index) => `linked message ${index + 1}`,
    );
    const getRoomsForParticipants = vi.fn(async () => [
      ROOM_ID,
      ALIAS_ROOM_ID,
      ALIAS_ROOM_ID,
      REQUESTER_ONLY_ROOM_ID,
    ]);
    const getRoomsForParticipant = vi.fn(async () => [ROOM_ID, ALIAS_ROOM_ID]);
    const getMemoriesByRoomIds = vi.fn(async () =>
      completeTexts.map(
        (text, index) =>
          ({
            ...message(),
            id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
            entityId: index % 2 === 0 ? ENTITY_ID : ALIAS_ENTITY_ID,
            roomId: index % 2 === 0 ? ROOM_ID : ALIAS_ROOM_ID,
            content: { text },
            createdAt: index + 1,
          }) as Memory,
      ),
    );
    const getRoomsByIds = vi.fn(async () => [
      { id: ROOM_ID, source: "discord", name: "general" },
      { id: ALIAS_ROOM_ID, source: "telegram", name: "saved-messages" },
    ]);
    const runtime = makeRuntime({
      getRoomsForParticipants,
      getRoomsForParticipant,
      getMemoriesByRoomIds,
      getRoomsByIds,
    });

    const result = await recentConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(getVerifiedRelatedEntityIds).toHaveBeenCalledWith(
      runtime,
      ENTITY_ID,
    );
    expect(getRoomsForParticipants).toHaveBeenCalledWith([
      ENTITY_ID,
      ALIAS_ENTITY_ID,
    ]);
    expect(getRoomsForParticipant).toHaveBeenCalledWith(AGENT_ID);
    expect(getMemoriesByRoomIds).toHaveBeenCalledWith({
      tableName: "messages",
      roomIds: [ROOM_ID, ALIAS_ROOM_ID],
    });
    expect(getRoomsByIds).toHaveBeenCalledOnce();
    expect(getRoomsByIds).toHaveBeenCalledWith([ROOM_ID, ALIAS_ROOM_ID]);
    expect(result.values?.recentConversationCount).toBe(15);
    expect(result.data?.messages).toHaveLength(15);
    for (const text of completeTexts) expect(result.text).toContain(text);
  });

  it("keeps attachment-only cross-platform turns as multimodal context without capability URLs", async () => {
    const runtime = makeRuntime({
      getMemoriesByRoomIds: vi.fn(async () => [
        {
          ...message(),
          content: {
            attachments: [
              {
                id: "photo-1",
                url: "https://private.example/full-resolution.png",
                thumbnailUrl: "https://private.example/thumbnail.png",
                filename: "receipt.png",
                mimeType: "image/png",
                description: "A receipt showing a 6:30 PM dinner reservation",
              },
            ],
          },
        } as Memory,
      ]),
    });

    const result = await recentConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(result.text).toContain(
      "[attachment: receipt.png; image/png; A receipt showing a 6:30 PM dinner reservation]",
    );
    expect(result.text).not.toContain("private.example");
    expect(result.values?.recentConversationCount).toBe(1);
    expect(result.data?.messages).toEqual([
      expect.objectContaining({
        text: undefined,
        attachments: [
          expect.objectContaining({
            id: "photo-1",
            filename: "receipt.png",
            mimeType: "image/png",
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(result.data)).not.toContain("private.example");
  });

  it("denies group disclosure before identity or room-history queries", async () => {
    revalidateOwnerExclusiveDisclosure.mockResolvedValue({
      allowed: false,
      reason: "destination_not_private",
    });
    const runtime = makeRuntime();

    const result = await recentConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(result).toEqual({ text: "", values: {}, data: {} });
    expect(recordOwnerExclusiveSuppression).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: ENTITY_ID }),
      "destination_not_private",
    );
    expect(getVerifiedRelatedEntityIds).not.toHaveBeenCalled();
    expect(runtime.getRoomsForParticipants).not.toHaveBeenCalled();
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
    expect(runtime.getMemoriesByRoomIds).not.toHaveBeenCalled();
    expect(runtime.getRoomsByIds).not.toHaveBeenCalled();
    expect(markOwnerExclusiveDisclosureUsed).not.toHaveBeenCalled();
  });

  it("reports a recall failure and degrades to empty context, not fabricated history", async () => {
    const reportError = vi.fn();
    const runtime = makeRuntime({
      getRoom: async () => {
        throw new Error("room store unavailable");
      },
      reportError,
    });

    const result = await recentConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe("RecentConversationsProvider");
    expect(reportError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("returns empty context without reporting when there is no entity id", async () => {
    const reportError = vi.fn();
    const runtime = makeRuntime({ reportError });

    const result = await recentConversationsProvider.get(
      runtime,
      { ...message(), entityId: undefined } as unknown as Memory,
      EMPTY_STATE,
    );

    expect(reportError).not.toHaveBeenCalled();
    expect(revalidateOwnerExclusiveDisclosure).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });
});
