/**
 * Exercises local channel selection against explicit storage collaborators.
 * Batch results may be unordered or missing; participant order breaks name ties.
 */
import { ChannelType, type Room, type UUID } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import { resolveLocalChannelRoom } from "./message.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UUID;
const room = (n: number, overrides: Partial<Room> = {}): Room => ({
  id: id(n),
  name: "general",
  source: "discord",
  type: ChannelType.GROUP,
  ...overrides,
});

function storage(ids: UUID[], rows: Room[]) {
  const getRoom = vi.fn(
    async (key: UUID) => rows.find((entry) => entry.id === key) ?? null,
  );
  const getRoomsByIds = vi.fn(async (_keys: UUID[]) => rows);
  const getRoomsForParticipant = vi.fn(async () => ids);
  return {
    getRoom,
    getRoomsByIds,
    getRoomsForParticipant,
    runtime: createMockRuntime({
      getRoom,
      getRoomsByIds,
      getRoomsForParticipant,
    }),
  };
}

describe("resolveLocalChannelRoom", () => {
  it("batches rooms without changing source, text-channel or participant-order ranking", async () => {
    const first = room(2);
    const later = room(3);
    const voice = room(4, { type: ChannelType.VOICE_GROUP });
    const otherSource = room(5, { source: "telegram" });
    const partial = room(6, { name: "general-announcements" });
    const ids = [
      id(1),
      voice.id,
      otherSource.id,
      partial.id,
      first.id,
      later.id,
    ];
    const h = storage(ids, [later, first, partial, otherSource, voice]);
    expect(
      await resolveLocalChannelRoom(h.runtime, "discord", "#general"),
    ).toEqual(first);
    expect(h.getRoomsByIds).toHaveBeenCalledExactlyOnceWith(ids);
    expect(h.getRoom).not.toHaveBeenCalled();
  });

  it("returns null without a query when the agent has no rooms", async () => {
    const h = storage([], []);
    expect(
      await resolveLocalChannelRoom(h.runtime, "discord", "general"),
    ).toBeNull();
    expect(h.getRoomsByIds).not.toHaveBeenCalled();
    expect(h.getRoom).not.toHaveBeenCalled();
  });

  it("retains the direct UUID lookup without participant discovery", async () => {
    const direct = room(1);
    const h = storage([], [direct]);
    expect(
      await resolveLocalChannelRoom(h.runtime, "discord", direct.id),
    ).toEqual(direct);
    expect(h.getRoom).toHaveBeenCalledExactlyOnceWith(direct.id);
    expect(h.getRoomsForParticipant).not.toHaveBeenCalled();
    expect(h.getRoomsByIds).not.toHaveBeenCalled();
  });

  it("falls back to name discovery when a UUID has no stored room", async () => {
    const named = room(2, { name: id(1) });
    const h = storage([named.id], [named]);
    expect(await resolveLocalChannelRoom(h.runtime, "discord", id(1))).toEqual(
      named,
    );
    expect(h.getRoom).toHaveBeenCalledExactlyOnceWith(id(1));
    expect(h.getRoomsByIds).toHaveBeenCalledExactlyOnceWith([named.id]);
  });

  it("propagates storage failure instead of reporting no matching channel", async () => {
    const failure = new Error("room storage unavailable");
    const h = storage([id(1)], []);
    h.getRoom.mockRejectedValue(failure);
    h.getRoomsByIds.mockRejectedValue(failure);
    await expect(
      resolveLocalChannelRoom(h.runtime, "discord", "general"),
    ).rejects.toBe(failure);
  });
});
