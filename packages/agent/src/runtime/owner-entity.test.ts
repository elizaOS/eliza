/**
 * Behavioral coverage for agent owner-entity resolution. Drives the real
 * module: configured-owner short-circuit, world-metadata scan order, empty
 * and single-element room queues, skipped rooms, missing items, and both
 * per-room and outer lookup failures. Runtime collaborators are hand-built
 * stubs; core's canonical-owner and deterministic-id helpers run for real.
 */
import {
  deterministicOwnerEntityId,
  type IAgentRuntime,
  logger,
  resolveCanonicalOwnerId,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveFallbackOwnerEntityId,
  resolveOwnerEntityId,
} from "./owner-entity.ts";

const AGENT_ID = "4c2a1d0e-9f8b-4a7c-8d6e-5f4a3b2c1d0e" as UUID;
const OTHER_AGENT_ID = "9f0c1b2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c" as UUID;
const CONFIGURED_OWNER = "7b3e2f7a-1111-4222-8333-944445555666";
const CONTACT_OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WORLD_OWNER = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const LATER_WORLD_OWNER = "cccccccc-dddd-4eee-8fff-000000000000";
const ROOM_A = "11111111-1111-4111-8111-111111111111" as UUID;
const ROOM_B = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM_C = "55555555-5555-4555-8555-555555555555" as UUID;
const WORLD_A = "33333333-3333-4333-8333-333333333333" as UUID;
const WORLD_B = "44444444-4444-4444-8444-444444444444" as UUID;

type RoomStub = { worldId?: UUID } | null;
type WorldStub = { metadata?: unknown } | null;

function stubRuntime(options?: {
  agentId?: UUID;
  settings?: Record<string, unknown>;
  rooms?: UUID[];
  roomsError?: unknown;
  roomsById?: Record<string, RoomStub>;
  worldsById?: Record<string, WorldStub>;
  roomErrors?: Record<string, unknown>;
  worldErrors?: Record<string, unknown>;
}): IAgentRuntime {
  const settings = options?.settings ?? {};
  const roomsById = options?.roomsById ?? {};
  const worldsById = options?.worldsById ?? {};
  const roomErrors = options?.roomErrors ?? {};
  const worldErrors = options?.worldErrors ?? {};

  return {
    agentId: options?.agentId ?? AGENT_ID,
    getSetting: (key: string) => settings[key] ?? null,
    getRoomsForParticipant: vi.fn(async () => {
      if (options?.roomsError !== undefined) {
        throw options.roomsError;
      }
      return options?.rooms ?? [];
    }),
    getRoom: vi.fn(async (roomId: UUID) => {
      if (Object.hasOwn(roomErrors, roomId)) {
        throw roomErrors[roomId];
      }
      return Object.hasOwn(roomsById, roomId) ? roomsById[roomId] : null;
    }),
    getWorld: vi.fn(async (worldId: UUID) => {
      if (Object.hasOwn(worldErrors, worldId)) {
        throw worldErrors[worldId];
      }
      return Object.hasOwn(worldsById, worldId) ? worldsById[worldId] : null;
    }),
  } as unknown as IAgentRuntime;
}

function worldWithOwner(ownerId: string): WorldStub {
  return { metadata: { ownership: { ownerId } } };
}

describe("resolveFallbackOwnerEntityId", () => {
  it("seeds the fallback from the agent id, never a character name", () => {
    const runtime = stubRuntime();
    const resolved = resolveFallbackOwnerEntityId(runtime);
    expect(resolved).toBe(deterministicOwnerEntityId(AGENT_ID));
    expect(resolved).toBe(stringToUuid(`${AGENT_ID}-admin-entity`));
    expect(resolved).not.toBe(stringToUuid("Eliza-admin-entity"));
  });

  it("is stable for one agent and distinct across agents", () => {
    const first = resolveFallbackOwnerEntityId(stubRuntime());
    const again = resolveFallbackOwnerEntityId(stubRuntime());
    const other = resolveFallbackOwnerEntityId(
      stubRuntime({ agentId: OTHER_AGENT_ID }),
    );
    expect(first).toBe(again);
    expect(other).toBe(deterministicOwnerEntityId(OTHER_AGENT_ID));
    expect(other).not.toBe(first);
  });
});

describe("resolveOwnerEntityId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the configured canonical owner and does not scan rooms", async () => {
    const runtime = stubRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: CONFIGURED_OWNER },
      rooms: [ROOM_A],
      roomsById: { [ROOM_A]: { worldId: WORLD_A } },
      worldsById: { [WORLD_A]: worldWithOwner(WORLD_OWNER) },
    });

    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(CONFIGURED_OWNER);
    expect(resolveCanonicalOwnerId(runtime)).toBe(CONFIGURED_OWNER);
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
    expect(runtime.getRoom).not.toHaveBeenCalled();
    expect(runtime.getWorld).not.toHaveBeenCalled();
  });

  it("trims a configured owner and treats whitespace-only as unset", async () => {
    const trimmed = stubRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: `  ${CONFIGURED_OWNER}  ` },
    });
    await expect(resolveOwnerEntityId(trimmed)).resolves.toBe(CONFIGURED_OWNER);

    const blank = stubRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: "   " },
    });
    await expect(resolveOwnerEntityId(blank)).resolves.toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
    expect(blank.getRoomsForParticipant).toHaveBeenCalledWith(AGENT_ID);
  });

  it("prefers ELIZA_ADMIN_ENTITY_ID over owner-contact entity ids", async () => {
    const runtime = stubRuntime({
      settings: {
        ELIZA_ADMIN_ENTITY_ID: CONFIGURED_OWNER,
        ELIZA_OWNER_CONTACTS_JSON: JSON.stringify({
          discord: { entityId: CONTACT_OWNER },
        }),
      },
      rooms: [ROOM_A],
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(CONFIGURED_OWNER);
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("uses the first owner-contact entity id when no admin setting is set", async () => {
    const runtime = stubRuntime({
      settings: {
        ELIZA_OWNER_CONTACTS_JSON: JSON.stringify({
          discord: { entityId: CONTACT_OWNER },
          telegram: { entityId: WORLD_OWNER },
        }),
      },
      rooms: [ROOM_A],
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(CONTACT_OWNER);
    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("falls back to the synthetic owner when the room queue is empty", async () => {
    const runtime = stubRuntime({ rooms: [] });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(
      resolveFallbackOwnerEntityId(runtime),
    );
    expect(runtime.getRoomsForParticipant).toHaveBeenCalledOnce();
    expect(runtime.getRoomsForParticipant).toHaveBeenCalledWith(AGENT_ID);
    expect(runtime.getRoom).not.toHaveBeenCalled();
  });

  it("returns world ownership from a single room", async () => {
    const runtime = stubRuntime({
      rooms: [ROOM_A],
      roomsById: { [ROOM_A]: { worldId: WORLD_A } },
      worldsById: { [WORLD_A]: worldWithOwner(WORLD_OWNER) },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
    expect(runtime.getWorld).toHaveBeenCalledWith(WORLD_A);
  });

  it("skips rooms without a worldId and keeps scanning", async () => {
    const runtime = stubRuntime({
      rooms: [ROOM_A, ROOM_B, ROOM_C],
      roomsById: {
        [ROOM_A]: null,
        [ROOM_B]: { worldId: undefined },
        [ROOM_C]: { worldId: WORLD_B },
      },
      worldsById: { [WORLD_B]: worldWithOwner(WORLD_OWNER) },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
    expect(runtime.getWorld).toHaveBeenCalledOnce();
    expect(runtime.getWorld).toHaveBeenCalledWith(WORLD_B);
  });

  it("returns the first world owner in room order and does not inspect later worlds", async () => {
    const runtime = stubRuntime({
      rooms: [ROOM_A, ROOM_B],
      roomsById: {
        [ROOM_A]: { worldId: WORLD_A },
        [ROOM_B]: { worldId: WORLD_B },
      },
      worldsById: {
        [WORLD_A]: worldWithOwner(WORLD_OWNER),
        [WORLD_B]: worldWithOwner(LATER_WORLD_OWNER),
      },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
    expect(runtime.getRoom).toHaveBeenCalledTimes(1);
    expect(runtime.getWorld).toHaveBeenCalledTimes(1);
    expect(runtime.getWorld).toHaveBeenCalledWith(WORLD_A);
  });

  it("skips worlds with missing, empty, or owner-less metadata", async () => {
    const runtime = stubRuntime({
      rooms: [ROOM_A, ROOM_B, ROOM_C],
      roomsById: {
        [ROOM_A]: { worldId: WORLD_A },
        [ROOM_B]: { worldId: WORLD_B },
        [ROOM_C]: { worldId: WORLD_B },
      },
      worldsById: {
        [WORLD_A]: null,
        [WORLD_B]: { metadata: { ownership: { ownerId: "" } } },
      },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
  });

  it("treats missing ownership and missing metadata as skippable, then a later owner wins", async () => {
    const skippedWorld = "66666666-6666-4666-8666-666666666666" as UUID;
    const emptyMetaWorld = "77777777-7777-4777-8777-777777777777" as UUID;
    const runtime = stubRuntime({
      rooms: [ROOM_A, ROOM_B, ROOM_C],
      roomsById: {
        [ROOM_A]: { worldId: skippedWorld },
        [ROOM_B]: { worldId: emptyMetaWorld },
        [ROOM_C]: { worldId: WORLD_A },
      },
      worldsById: {
        [skippedWorld]: { metadata: { ownership: {} } },
        [emptyMetaWorld]: { metadata: undefined },
        [WORLD_A]: worldWithOwner(WORLD_OWNER),
      },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
  });

  it("returns a world ownerId as recorded, including a non-UUID platform id", async () => {
    const runtime = stubRuntime({
      rooms: [ROOM_A],
      roomsById: { [ROOM_A]: { worldId: WORLD_A } },
      worldsById: { [WORLD_A]: worldWithOwner("1830340867737178112") },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(
      "1830340867737178112",
    );
  });

  it("returns a whitespace-only world ownerId because the scan treats it as present", async () => {
    const runtime = stubRuntime({
      rooms: [ROOM_A],
      roomsById: { [ROOM_A]: { worldId: WORLD_A } },
      worldsById: { [WORLD_A]: worldWithOwner("   ") },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe("   ");
  });

  it("continues after a missing room lookup and a per-room Error, then takes a later owner", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const runtime = stubRuntime({
      rooms: [ROOM_A, ROOM_B, ROOM_C],
      roomsById: {
        [ROOM_C]: { worldId: WORLD_B },
      },
      roomErrors: { [ROOM_B]: new Error("room lookup failed") },
      worldsById: { [WORLD_B]: worldWithOwner(WORLD_OWNER) },
    });

    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
    expect(debug).toHaveBeenCalledWith(
      `[owner-entity] World ownership lookup failed for room ${ROOM_B}: room lookup failed`,
    );
    expect(runtime.getRoom).toHaveBeenCalledTimes(3);
  });

  it("stringifies a non-Error per-room failure and keeps scanning", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const runtime = stubRuntime({
      rooms: [ROOM_A, ROOM_B],
      roomsById: {
        [ROOM_A]: { worldId: WORLD_A },
        [ROOM_B]: { worldId: WORLD_B },
      },
      worldErrors: { [WORLD_A]: "world down" },
      worldsById: { [WORLD_B]: worldWithOwner(WORLD_OWNER) },
    });

    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
    expect(debug).toHaveBeenCalledWith(
      `[owner-entity] World ownership lookup failed for room ${ROOM_A}: world down`,
    );
  });

  it("falls back when listing rooms throws an Error", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const runtime = stubRuntime({
      roomsError: new Error("participant rooms failed"),
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(
      deterministicOwnerEntityId(AGENT_ID),
    );
    expect(warn).toHaveBeenCalledWith(
      "[owner-entity] Failed to resolve owner from world metadata; falling back to synthetic owner id: participant rooms failed",
    );
    expect(runtime.getRoom).not.toHaveBeenCalled();
  });

  it("falls back when listing rooms throws a non-Error and stringifies it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const runtime = stubRuntime({ roomsError: 42 });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(
      resolveFallbackOwnerEntityId(runtime),
    );
    expect(warn).toHaveBeenCalledWith(
      "[owner-entity] Failed to resolve owner from world metadata; falling back to synthetic owner id: 42",
    );
  });

  it("does not treat a non-string configured owner as canonical", async () => {
    const runtime = stubRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: 12345 },
      rooms: [ROOM_A],
      roomsById: { [ROOM_A]: { worldId: WORLD_A } },
      worldsById: { [WORLD_A]: worldWithOwner(WORLD_OWNER) },
    });
    await expect(resolveOwnerEntityId(runtime)).resolves.toBe(WORLD_OWNER);
  });
});
