/**
 * Verifies the shared session-room ladder: precedence, the binding set, and —
 * the anti-drift contract — agreement with the router's `readOrigin` on the
 * reply room for representative session metadata shapes. Deterministic; no
 * runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  resolveOriginRoomId,
  sessionBoundRoomIds,
} from "../../src/services/session-room-binding.js";
import { readOrigin } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ORIGIN = "11111111-1111-4111-8111-111111111111";
const SOURCE_ROOM = "33333333-3333-4333-8333-333333333333";
const TASK = "22222222-2222-4222-8222-222222222222";
const THREAD = "44444444-4444-4444-8444-444444444444";

function sessionWith(meta: Record<string, unknown>): SessionInfo {
  return {
    id: "s1",
    name: "demo",
    agentType: "codex",
    workdir: "/tmp/wf",
    status: "ready",
    approvalPreset: "standard",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: meta,
  } as SessionInfo;
}

describe("resolveOriginRoomId", () => {
  it("prefers originRoomId over sourceRoomId over taskRoomId over roomId", () => {
    expect(
      resolveOriginRoomId({
        originRoomId: ORIGIN,
        sourceRoomId: SOURCE_ROOM,
        taskRoomId: TASK,
        roomId: TASK,
      }),
    ).toBe(ORIGIN);
    expect(
      resolveOriginRoomId({
        sourceRoomId: SOURCE_ROOM,
        taskRoomId: TASK,
        roomId: TASK,
      }),
    ).toBe(SOURCE_ROOM);
    expect(resolveOriginRoomId({ taskRoomId: TASK, roomId: TASK })).toBe(TASK);
    expect(resolveOriginRoomId({ roomId: TASK })).toBe(TASK);
    expect(resolveOriginRoomId({})).toBeUndefined();
    expect(resolveOriginRoomId(undefined)).toBeUndefined();
  });

  it("ignores blank/non-string/non-UUID values instead of returning them", () => {
    expect(
      resolveOriginRoomId({
        originRoomId: "  ",
        sourceRoomId: 7,
        taskRoomId: "not-a-uuid",
        roomId: TASK,
      }),
    ).toBe(TASK);
  });

  it("rejects non-UUID room ids in the binding set (same validation as readOrigin)", () => {
    const rooms = sessionBoundRoomIds({
      roomId: "not-a-uuid",
      originRoomId: ORIGIN,
    });
    expect(rooms).toEqual(new Set([ORIGIN]));
  });

  it("agrees with the router's readOrigin reply room (anti-drift contract)", () => {
    const shapes: Array<Record<string, unknown>> = [
      // Default-on task rooms: roomId = minted task room, origin carried aside.
      { roomId: TASK, taskRoomId: TASK, originRoomId: ORIGIN },
      // sourceRoomId-only spawn path.
      { roomId: TASK, taskRoomId: TASK, sourceRoomId: SOURCE_ROOM },
      // Task rooms opted out: origin room IS the session room.
      { roomId: ORIGIN, taskRoomId: ORIGIN },
      // Legacy session predating task rooms entirely.
      { roomId: ORIGIN },
    ];
    for (const meta of shapes) {
      const origin = readOrigin(sessionWith(meta));
      expect(origin).not.toBeNull();
      expect(resolveOriginRoomId(meta)).toBe(origin?.roomId);
    }
  });
});

describe("sessionBoundRoomIds", () => {
  it("collects task, origin, source, and thread rooms without duplicates", () => {
    const rooms = sessionBoundRoomIds({
      roomId: TASK,
      taskRoomId: TASK,
      originRoomId: ORIGIN,
      sourceRoomId: SOURCE_ROOM,
      threadRoomId: THREAD,
    });
    expect(rooms).toEqual(new Set([TASK, ORIGIN, SOURCE_ROOM, THREAD]));
  });

  it("is empty for missing metadata", () => {
    expect(sessionBoundRoomIds(undefined).size).toBe(0);
    expect(sessionBoundRoomIds({}).size).toBe(0);
  });
});
