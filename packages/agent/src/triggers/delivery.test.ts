/**
 * Unit tests for trigger delivery-binding resolution and delivery-failure
 * classification (`delivery.ts`). Deterministic: a minimal mocked runtime
 * provides the room/memory queries; no real database or message pipeline.
 */
import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { isElizaError, stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  countTrailingDeliveryFailures,
  isNoConversationDeliveryError,
  resolveTriggerDeliveryBinding,
  TRIGGER_DELIVERY_FAILURE_CODE,
  TRIGGER_DELIVERY_UNBOUND_CODE,
} from "./delivery.ts";
import type { TriggerRunRecord } from "./types.ts";

const AGENT_NAME = "delivery-test-agent";
const WORLD_ID = stringToUuid(`${AGENT_NAME}-web-chat-world`);

interface RoomSeed {
  id: UUID;
  channelId?: string;
  latestMessageAt?: number;
}

function makeRuntime(seeds: RoomSeed[]): IAgentRuntime {
  const rooms = new Map<UUID, RoomSeed>(seeds.map((seed) => [seed.id, seed]));
  return {
    character: { name: AGENT_NAME },
    getRoom: async (roomId: UUID) =>
      rooms.has(roomId) ? ({ id: roomId } as Room) : null,
    getRoomsByWorlds: async (worldIds: UUID[]) =>
      worldIds.includes(WORLD_ID)
        ? seeds.map(
            (seed) => ({ id: seed.id, channelId: seed.channelId }) as Room,
          )
        : [],
    getMemories: async (params: { roomId: UUID }) => {
      const seed = rooms.get(params.roomId);
      return seed?.latestMessageAt
        ? ([{ createdAt: seed.latestMessageAt }] as Memory[])
        : [];
    },
  } as unknown as IAgentRuntime;
}

describe("resolveTriggerDeliveryBinding", () => {
  it("keeps the creating conversation's room for chat-created triggers", async () => {
    const creatingRoomId = stringToUuid("creating-room");
    const binding = await resolveTriggerDeliveryBinding(makeRuntime([]), {
      creatingRoomId,
    });
    expect(binding).toEqual({
      roomId: creatingRoomId,
      origin: "creating-room",
    });
  });

  it("binds to an explicitly named room after verifying it exists", async () => {
    const explicitRoomId = stringToUuid("explicit-room");
    const runtime = makeRuntime([{ id: explicitRoomId }]);
    const binding = await resolveTriggerDeliveryBinding(runtime, {
      explicitRoomId,
    });
    expect(binding).toEqual({
      roomId: explicitRoomId,
      origin: "explicit-room",
    });
  });

  it("rejects an explicit room that does not exist with the typed unbound code", async () => {
    const runtime = makeRuntime([]);
    await expect(
      resolveTriggerDeliveryBinding(runtime, {
        explicitRoomId: stringToUuid("missing-room"),
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isElizaError(err) && err.code === TRIGGER_DELIVERY_UNBOUND_CODE,
    );
  });

  it("falls back to the most recently active dashboard conversation for roomless creates", async () => {
    const older = stringToUuid("conv-older");
    const newer = stringToUuid("conv-newer");
    const runtime = makeRuntime([
      { id: older, channelId: "web-conv-aaa", latestMessageAt: 1_000 },
      { id: newer, channelId: "web-conv-bbb", latestMessageAt: 2_000 },
      // Non-conversation rooms in the world must never become the binding.
      {
        id: stringToUuid("scratch"),
        channelId: "other",
        latestMessageAt: 9_000,
      },
    ]);
    const binding = await resolveTriggerDeliveryBinding(runtime);
    expect(binding).toEqual({ roomId: newer, origin: "default-conversation" });
  });

  it("rejects a roomless create with the typed, actionable unbound error when no conversation exists", async () => {
    const runtime = makeRuntime([
      { id: stringToUuid("scratch"), channelId: "not-a-conversation" },
    ]);
    await expect(resolveTriggerDeliveryBinding(runtime)).rejects.toSatisfy(
      (err: unknown) =>
        isElizaError(err) &&
        err.code === TRIGGER_DELIVERY_UNBOUND_CODE &&
        err.message.includes("no delivery conversation available") &&
        err.message.includes("roomId"),
    );
  });
});

describe("isNoConversationDeliveryError", () => {
  it("matches the raw send-handler throw shape", () => {
    expect(
      isNoConversationDeliveryError(
        "Error: autonomy-service send failed: no conversation available to deliver message",
      ),
    ).toBe(true);
  });

  it("matches a run record already stamped with the structured code", () => {
    expect(
      isNoConversationDeliveryError(
        `${TRIGGER_DELIVERY_FAILURE_CODE}: delivery failed`,
      ),
    ).toBe(true);
  });

  it("does not match other errors or missing values", () => {
    expect(isNoConversationDeliveryError("workflow blew up")).toBe(false);
    expect(isNoConversationDeliveryError(undefined)).toBe(false);
    expect(isNoConversationDeliveryError(null)).toBe(false);
  });
});

describe("countTrailingDeliveryFailures", () => {
  function run(status: "success" | "error", error?: string): TriggerRunRecord {
    return {
      triggerRunId: stringToUuid(`r-${Math.random()}`),
      triggerId: stringToUuid("t"),
      taskId: stringToUuid("task"),
      startedAt: 0,
      finishedAt: 1,
      status,
      error,
      latencyMs: 1,
      source: "scheduler",
    };
  }

  it("counts only the trailing streak of delivery failures", () => {
    const deliveryError = `${TRIGGER_DELIVERY_FAILURE_CODE}: no conversation available to deliver message`;
    expect(countTrailingDeliveryFailures([])).toBe(0);
    expect(countTrailingDeliveryFailures([run("success")])).toBe(0);
    expect(
      countTrailingDeliveryFailures([
        run("error", deliveryError),
        run("success"),
        run("error", deliveryError),
        run("error", deliveryError),
      ]),
    ).toBe(2);
    // A non-delivery error breaks the streak even when older delivery
    // failures exist.
    expect(
      countTrailingDeliveryFailures([
        run("error", deliveryError),
        run("error", "engine busy"),
      ]),
    ).toBe(0);
  });
});
