/**
 * Distinct task rooms: a spawned coding task (and its swarm of sub-agents)
 * should live in its OWN room, separate from the originating chat room.
 *
 * Contract under test (ensureDistinctTaskRoom wired into TASKS:spawn_agent /
 * TASKS:create):
 *  - A spawn with NO explicit taskRoomId mints a distinct room id != origin,
 *    created via runtime.createRoom and stamped onto the sub-agent metadata.
 *  - All sub-agents resolved within ONE spawn call share that single room
 *    (swarm collaboration); a SEPARATE spawn call mints a DIFFERENT room
 *    (different task → different room).
 *  - The opt-out `ELIZA_ORCHESTRATOR_TASK_ROOMS=0` keeps origin == task room
 *    (legacy single-room behavior, no createRoom).
 *  - An explicit taskRoomId always wins (nested children JOIN the parent's
 *    room) and never mints.
 *  - The origin chat room is preserved separately on the swarm metadata.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { spawnAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const spawnOptions = { parameters: { action: "spawn_agent" } };
const ORIGIN_ROOM = "room1"; // memory() default roomId
const EXPLICIT_TASK_ROOM = "11111111-2222-3333-4444-555555555555";

/**
 * Runtime double that, unlike the shared `runtimeWith`, exposes the room-minting
 * surface ensureDistinctTaskRoom needs (createRoom / ensureWorldExists /
 * getSetting / agentId), capturing every createRoom call for assertions.
 */
function roomMintingRuntime(
  service: unknown,
  settings: Record<string, string | undefined> = {},
): {
  runtime: IAgentRuntime;
  createdRooms: Array<{ id: string; name?: string; worldId?: string }>;
  createRoom: ReturnType<typeof vi.fn>;
} {
  const createdRooms: Array<{ id: string; name?: string; worldId?: string }> =
    [];
  const createRoom = vi.fn(async (room: { id: string }) => {
    createdRooms.push(room as never);
    return room.id;
  });
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getService: vi.fn(() => service ?? null),
    hasService: vi.fn(() => Boolean(service)),
    getSetting: vi.fn((key: string) => settings[key] ?? undefined),
    createRoom,
    ensureWorldExists: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never as IAgentRuntime;
  return { runtime, createdRooms, createRoom };
}

function spawnMeta(
  svc: ReturnType<typeof serviceMock>,
): Record<string, unknown> {
  const call = svc.spawnSession.mock.calls.at(-1)?.[0] as {
    metadata?: Record<string, unknown>;
  };
  return call.metadata ?? {};
}

describe("TASKS distinct task rooms", () => {
  it("mints a distinct task room (!= origin) when no taskRoomId is given", async () => {
    const svc = serviceMock();
    const { runtime, createdRooms } = roomMintingRuntime(svc);
    const result = await spawnAgentAction.handler(
      runtime,
      memory({ task: "build the thing", agentType: "codex" }),
      state,
      spawnOptions,
      callback(),
    );

    expect(result?.success).toBe(true);
    // A fresh room was created...
    expect(createdRooms).toHaveLength(1);
    const mintedRoom = createdRooms[0].id;
    expect(mintedRoom).not.toBe(ORIGIN_ROOM);
    // ...and stamped onto the sub-agent as its task room, with the origin
    // chat room preserved separately for status bridging.
    const meta = spawnMeta(svc);
    expect(meta.taskRoomId).toBe(mintedRoom);
    expect(meta.roomId).toBe(mintedRoom);
    expect(meta.originRoomId).toBe(ORIGIN_ROOM);
    expect(meta.taskRoomId).not.toBe(meta.originRoomId);
  });

  it("gives DIFFERENT tasks DIFFERENT rooms (separate spawn calls)", async () => {
    const svc = serviceMock();
    const { runtime, createdRooms } = roomMintingRuntime(svc);
    await spawnAgentAction.handler(
      runtime,
      memory({ task: "task one", agentType: "codex" }),
      state,
      spawnOptions,
      callback(),
    );
    const firstRoom = spawnMeta(svc).taskRoomId;

    await spawnAgentAction.handler(
      runtime,
      memory({ task: "task two", agentType: "codex" }),
      state,
      spawnOptions,
      callback(),
    );
    const secondRoom = spawnMeta(svc).taskRoomId;

    expect(createdRooms).toHaveLength(2);
    expect(firstRoom).toBeDefined();
    expect(secondRoom).toBeDefined();
    expect(firstRoom).not.toBe(secondRoom);
  });

  it("keeps origin == task room when opted out via ELIZA_ORCHESTRATOR_TASK_ROOMS=0", async () => {
    const svc = serviceMock();
    const { runtime, createRoom } = roomMintingRuntime(svc, {
      ELIZA_ORCHESTRATOR_TASK_ROOMS: "0",
    });
    const result = await spawnAgentAction.handler(
      runtime,
      memory({ task: "legacy single-room", agentType: "codex" }),
      state,
      spawnOptions,
      callback(),
    );

    expect(result?.success).toBe(true);
    // No room minted; the legacy single-room behavior is preserved.
    expect(createRoom).not.toHaveBeenCalled();
    const meta = spawnMeta(svc);
    expect(meta.taskRoomId).toBe(ORIGIN_ROOM);
    expect(meta.originRoomId).toBe(ORIGIN_ROOM);
    expect(meta.roomId).toBe(ORIGIN_ROOM);
  });

  it("honors an explicit taskRoomId (nested child JOINs the parent's room) and never mints", async () => {
    const svc = serviceMock();
    const { runtime, createRoom } = roomMintingRuntime(svc);
    const result = await spawnAgentAction.handler(
      runtime,
      memory({
        task: "join the swarm",
        agentType: "codex",
        taskRoomId: EXPLICIT_TASK_ROOM,
      }),
      state,
      spawnOptions,
      callback(),
    );

    expect(result?.success).toBe(true);
    // Caller intent wins → no new room.
    expect(createRoom).not.toHaveBeenCalled();
    const meta = spawnMeta(svc);
    expect(meta.taskRoomId).toBe(EXPLICIT_TASK_ROOM);
    expect(meta.roomId).toBe(EXPLICIT_TASK_ROOM);
    // Origin still tracked separately for status bridging.
    expect(meta.originRoomId).toBe(ORIGIN_ROOM);
  });

  it("falls back to the origin room when createRoom is unavailable", async () => {
    const svc = serviceMock();
    // A runtime WITHOUT createRoom (e.g. a thin host) must not break spawns:
    // best-effort fallback to the prior single-room behavior.
    const runtime = {
      agentId: "00000000-0000-0000-0000-0000000000bb",
      getService: vi.fn(() => svc),
      hasService: vi.fn(() => true),
      getSetting: vi.fn(() => undefined),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never as IAgentRuntime;

    const result = await spawnAgentAction.handler(
      runtime,
      memory({ task: "no room minter here", agentType: "codex" }),
      state,
      spawnOptions,
      callback(),
    );

    expect(result?.success).toBe(true);
    const meta = spawnMeta(svc);
    expect(meta.taskRoomId).toBe(ORIGIN_ROOM);
    expect(meta.originRoomId).toBe(ORIGIN_ROOM);
  });
});
