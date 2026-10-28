/**
 * ROOM action mute hardening: scope=server (world-level mute the inbound gate
 * consults) and durationMinutes persistence (agentMuteUntilIso, consumed by
 * the mute-state due-check). Map-backed runtime; the model gate answers via a
 * stubbed TEXT_SMALL response; assertions read the stores the inbound gate
 * reads, closing the loop from action write to message drop.
 */

import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type Room,
  type State,
  type UUID,
  validateToolArgs,
  type World,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../../../plugin-sql/src/__tests__/test-helpers";
import {
  resolveEffectiveMuteState,
  worldMuteActive,
} from "../../../services/message/mute-state.ts";
import { followRoomAction, roomOpAction } from "./room.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const SIBLING_ROOM_ID = "00000000-0000-0000-0000-0000000000d2" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;

function makeRuntime(seed?: {
  states?: Record<string, "FOLLOWED" | "MUTED">;
  rooms?: Room[];
  worlds?: World[];
}) {
  const states = new Map<string, "FOLLOWED" | "MUTED" | null>(
    Object.entries(seed?.states ?? {}),
  );
  const rooms = new Map<string, Room>(
    (seed?.rooms ?? []).map((room) => [room.id, room]),
  );
  const worlds = new Map<string, World>(
    (seed?.worlds ?? []).map((world) => [world.id, world]),
  );
  const memories: Memory[] = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    useModel: async () => "yes",
    createMemory: async (memory: Memory) => {
      memories.push(memory);
      return memory.id;
    },
    ensureParticipantInRoom: async () => {},
    getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
      states.get(`${roomId}:${entityId}`) ?? null,
    updateParticipantUserState: async (
      roomId: UUID,
      entityId: UUID,
      state: "FOLLOWED" | "MUTED" | null,
    ) => {
      states.set(`${roomId}:${entityId}`, state);
    },
    getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
    getRoomsForParticipant: async () => [...rooms.keys()] as UUID[],
    updateRoom: async (room: Room) => {
      rooms.set(room.id, room);
    },
    getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
    updateWorld: async (world: World) => {
      worlds.set(world.id, world);
    },
  } as unknown as IAgentRuntime;
  return { runtime, states, rooms, worlds, memories };
}

function room(id: UUID): Room {
  return {
    id,
    name: `room-${id.slice(-2)}`,
    source: "discord",
    type: "GROUP",
    worldId: WORLD_ID,
  } as Room;
}

function world(extra?: Partial<World>): World {
  return { id: WORLD_ID, agentId: AGENT_ID, name: "Cozy Devs", ...extra };
}

function msg(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000b1" as UUID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "discord" },
  } as Memory;
}

function opts(parameters: Record<string, unknown>): HandlerOptions {
  return { parameters } as HandlerOptions;
}

const state = { values: {}, data: {}, text: "" } as State;

describe("ROOM action — timed mute persistence (durationMinutes)", () => {
  it("mute with durationMinutes writes agentMuteUntilIso and returns scheduleAutoUnmuteIso", async () => {
    const { runtime, states, rooms } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const before = Date.now();
    const result = await roomOpAction.handler(
      runtime,
      msg("mute this channel for 30 minutes"),
      state,
      opts({ action: "mute", durationMinutes: 30 }),
    );
    expect(result.success).toBe(true);
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
    const untilIso = rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso;
    expect(typeof untilIso).toBe("string");
    const expiry = Date.parse(untilIso as string);
    expect(expiry).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
    expect((result.data as Record<string, unknown>).scheduleAutoUnmuteIso).toBe(
      untilIso,
    );
  });

  it("rejects a sub-minute duration instead of muting permanently", async () => {
    // 0.5 floored to 0, and a falsy duration is how this action encodes an
    // untimed mute — so "mute for 30 seconds" became a permanent mute.
    const { runtime, states, rooms } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("mute this channel for 30 seconds"),
      state,
      opts({ action: "mute", durationMinutes: 0.5 }),
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toBe(
      "ROOM_DURATION_INVALID",
    );
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeUndefined();
    expect(rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso).toBeUndefined();
  });

  it("rejects a sub-minute duration supplied as a string", async () => {
    const { runtime, states } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("mute this channel briefly"),
      state,
      opts({ action: "mute", durationMinutes: "0.5" }),
    );
    expect(result.success).toBe(false);
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeUndefined();
  });

  it("treats an explicit null duration as an untimed mute", async () => {
    const { runtime, states, rooms } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("mute this channel"),
      state,
      opts({ action: "mute", durationMinutes: null }),
    );
    expect(result.success).toBe(true);
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
    expect(rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso).toBeUndefined();
  });

  it("rejects an out-of-range duration before mutating room state", async () => {
    const { runtime, states, rooms } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("mute this channel for the maximum duration"),
      state,
      opts({ action: "mute", durationMinutes: Number.MAX_SAFE_INTEGER }),
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toBe(
      "ROOM_DURATION_INVALID",
    );
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeUndefined();
    expect(rooms.get(ROOM_ID)?.metadata?.agentMuteUntilIso).toBeUndefined();
  });

  it("ignores durationMinutes for operations where the field is not applicable", async () => {
    const { runtime, states } = makeRuntime({
      states: { [`${ROOM_ID}:${AGENT_ID}`]: "MUTED" },
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("unmute this channel"),
      state,
      opts({ action: "unmute", durationMinutes: 0.5 }),
    );
    expect(result.success).toBe(true);
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeNull();
  });

  it("an untimed mute clears a stale expiry; unmute clears state and expiry", async () => {
    const stale = new Date(Date.now() + 5 * 60_000).toISOString();
    const { runtime, states, rooms } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    rooms.set(ROOM_ID, {
      ...room(ROOM_ID),
      metadata: { agentMuteUntilIso: stale },
    });
    await roomOpAction.handler(
      runtime,
      msg("mute this channel"),
      state,
      opts({ action: "mute" }),
    );
    expect(rooms.get(ROOM_ID)?.metadata).not.toHaveProperty(
      "agentMuteUntilIso",
    );
    await roomOpAction.handler(
      runtime,
      msg("unmute this channel"),
      state,
      opts({ action: "unmute" }),
    );
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeNull();
  });
});

describe("ROOM action — scope=server (guild-wide mute)", () => {
  it("mutes the world; a sibling room in the same world then drops via the inbound gate", async () => {
    const { runtime, worlds } = makeRuntime({
      rooms: [room(ROOM_ID), room(SIBLING_ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("mute this whole server"),
      state,
      opts({ action: "mute", scope: "server" }),
    );
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).scope).toBe("server");
    expect(worlds.get(WORLD_ID)?.metadata?.agentMuteState).toBe("MUTED");
    // The guild mute drops a child channel that has no room-level mute.
    expect(
      await resolveEffectiveMuteState(runtime, {
        roomIds: [SIBLING_ROOM_ID],
      }),
    ).toEqual({ muted: true, scope: "server", worldId: WORLD_ID });
  });

  it("timed server mute stores the expiry; unmute clears the world metadata", async () => {
    const { runtime, worlds } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      runtime,
      msg("mute the server for an hour"),
      state,
      opts({ action: "mute", scope: "server", durationMinutes: 60 }),
    );
    expect(result.success).toBe(true);
    expect(typeof worlds.get(WORLD_ID)?.metadata?.agentMuteUntilIso).toBe(
      "string",
    );
    const unmuted = await roomOpAction.handler(
      runtime,
      msg("unmute the server"),
      state,
      opts({ action: "unmute", scope: "server" }),
    );
    expect(unmuted.success).toBe(true);
    const metadata = worlds.get(WORLD_ID)?.metadata ?? {};
    expect(metadata).not.toHaveProperty("agentMuteState");
    expect(metadata).not.toHaveProperty("agentMuteUntilIso");
  });

  it("preconditions: muting an already-muted server fails; scope=server rejects follow", async () => {
    const { runtime } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
    });
    const again = await roomOpAction.handler(
      runtime,
      msg("mute the server"),
      state,
      opts({ action: "mute", scope: "server" }),
    );
    expect(again.success).toBe(false);
    expect((again.values as Record<string, unknown>).error).toBe(
      "ROOM_MUTE_PRECONDITION_FAILED",
    );
    const follow = await roomOpAction.handler(
      runtime,
      msg("follow the server"),
      state,
      opts({ action: "follow", scope: "server" }),
    );
    expect(follow.success).toBe(false);
    expect((follow.values as Record<string, unknown>).error).toBe(
      "ROOM_SCOPE_INVALID",
    );
  });

  it("validate leaves a planner call to the handler, which names the failed precondition", async () => {
    const { runtime } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world({ metadata: { agentMuteState: "MUTED" } })],
    });
    for (const [parameters, error] of [
      [{ action: "mute", scope: "server" }, "ROOM_MUTE_PRECONDITION_FAILED"],
      [{ action: "unmute" }, "ROOM_UNMUTE_PRECONDITION_FAILED"],
      [{ action: "unfollow" }, "ROOM_UNFOLLOW_PRECONDITION_FAILED"],
      [
        { action: "mute", platform: "discord", chatName: "crypto signals" },
        "ROOM_NOT_FOUND",
      ],
    ] as const) {
      expect(validateToolArgs(roomOpAction, parameters).errors).toEqual([]);
      expect(
        await roomOpAction.validate(
          runtime,
          msg("room op"),
          state,
          opts(parameters),
        ),
      ).toBe(true);
      const result = await roomOpAction.handler(
        runtime,
        msg("room op"),
        state,
        opts(parameters),
      );
      expect(result?.success).toBe(false);
      expect(result?.values?.error).toBe(error);
    }
  });

  it("a child action is offered only when the current room state allows the operation", async () => {
    const { runtime } = makeRuntime({
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    expect(await followRoomAction.validate(runtime, msg("hi"), state)).toBe(
      true,
    );
    const followed = makeRuntime({
      states: { [`${ROOM_ID}:${AGENT_ID}`]: "FOLLOWED" },
      rooms: [room(ROOM_ID)],
      worlds: [world()],
    });
    expect(
      await followRoomAction.validate(followed.runtime, msg("hi"), state),
    ).toBe(false);
  });
});

describe("ROOM action — declared parameters match the handler", () => {
  it("refuses chatName without platform instead of muting the current room", async () => {
    const ctx = makeRuntime({ rooms: [room(ROOM_ID)], worlds: [world()] });
    for (const parameters of [
      { action: "mute", chatName: "crypto signals" },
      { action: "mute", chatName: "crypto signals", scope: "server" },
    ]) {
      expect(validateToolArgs(roomOpAction, parameters).errors).toEqual([]);
      const result = await roomOpAction.handler(
        ctx.runtime,
        msg("mute the crypto signals channel"),
        state,
        opts(parameters),
      );
      expect(result?.success).toBe(false);
      expect(result?.values?.error).toBe("ROOM_PLATFORM_REQUIRED");
    }
    expect(ctx.states.get(`${ROOM_ID}:${AGENT_ID}`)).toBeUndefined();
    expect(worldMuteActive(ctx.worlds.get(WORLD_ID) ?? null)).toBe(false);
  });

  it("names the room selected by roomId, not the room the message arrived in", async () => {
    const ctx = makeRuntime({
      rooms: [room(ROOM_ID), room(SIBLING_ROOM_ID)],
      worlds: [world()],
    });
    const result = await roomOpAction.handler(
      ctx.runtime,
      msg("mute that other channel"),
      { ...state, data: { room: room(ROOM_ID) } } as State,
      // roomId selects the room by itself, so a chatName sent with it is not
      // refused for a missing platform.
      opts({ action: "mute", roomId: SIBLING_ROOM_ID, chatName: "room-d2" }),
    );
    expect(result?.success).toBe(true);
    expect(ctx.states.get(`${SIBLING_ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
    expect(result?.text).toBe("Room muted: room-d2");
  });

  it("reports a roomId that names no room before the model gate runs", async () => {
    const ctx = makeRuntime({ rooms: [room(ROOM_ID)], worlds: [world()] });
    let modelCalls = 0;
    ctx.runtime.useModel = (async () => {
      modelCalls += 1;
      return "yes";
    }) as IAgentRuntime["useModel"];
    const parameters = { action: "mute", roomId: SIBLING_ROOM_ID };
    expect(validateToolArgs(roomOpAction, parameters).errors).toEqual([]);
    const result = await roomOpAction.handler(
      ctx.runtime,
      msg("mute that other channel"),
      { ...state, data: { room: room(ROOM_ID) } } as State,
      opts(parameters),
    );
    expect(result?.success).toBe(false);
    expect(result?.values?.error).toBe("ROOM_NOT_FOUND");
    expect(modelCalls).toBe(0);
    expect(ctx.memories).toEqual([]);
  });

  it("a child action does not declare or obey the parent's action discriminator", async () => {
    expect(followRoomAction.parameters?.map((p) => p.name)).not.toContain(
      "action",
    );
    expect(validateToolArgs(followRoomAction, { action: "mute" }).valid).toBe(
      false,
    );
    const ctx = makeRuntime({ rooms: [room(ROOM_ID)], worlds: [world()] });
    const result = await followRoomAction.handler(
      ctx.runtime,
      msg("follow this channel"),
      state,
      opts({ action: "mute" }),
    );
    expect(result?.success).toBe(true);
    expect(ctx.states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("FOLLOWED");
  });
});

describe("ROOM action — room without an agent participant row (real PGlite)", () => {
  it("mute adds the agent to the room so the mute holds", async () => {
    const f = await createIsolatedTestDatabase("room-mute-no-participant");
    const roomId = "00000000-0000-0000-0000-0000000000f1" as UUID;
    try {
      await f.runtime.createEntity({
        id: f.testAgentId,
        names: ["Agent"],
        agentId: f.testAgentId,
      });
      await f.runtime.ensureWorldExists({
        id: WORLD_ID,
        name: "Cozy Devs",
        agentId: f.testAgentId,
      });
      // A connector join creates the room without adding the agent to it.
      await f.runtime.ensureRoomExists({
        id: roomId,
        name: "general",
        source: "discord",
        type: "GROUP",
        channelId: "C1",
        worldId: WORLD_ID,
      } as Room);
      await f.runtime.createEntity({
        id: USER_ID,
        names: ["Owner"],
        agentId: f.testAgentId,
      });
      expect(await f.runtime.isRoomParticipant(roomId, f.testAgentId)).toBe(
        false,
      );

      const result = await roomOpAction.handler(
        f.runtime,
        { ...msg("mute #general"), agentId: f.testAgentId, roomId },
        state,
        opts({ action: "mute", platform: "discord", roomId }),
      );

      expect(result?.success).toBe(true);
      expect(
        await f.runtime.getParticipantUserState(roomId, f.testAgentId),
      ).toBe("MUTED");
      // The next inbound message joins the agent to the room; the mute stays.
      await f.runtime.ensureParticipantInRoom(f.testAgentId, roomId);
      expect(
        await f.runtime.getParticipantUserState(roomId, f.testAgentId),
      ).toBe("MUTED");
    } finally {
      await f.cleanup();
    }
  });
});
