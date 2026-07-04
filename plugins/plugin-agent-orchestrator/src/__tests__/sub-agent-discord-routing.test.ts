/**
 * Verifies sub-agent Discord reply routing.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  readOrigin,
  SUCCESSOR_ROOM_INHERITED_META_KEY,
  sanitizeSuccessorMetadata,
} from "../services/sub-agent-router.ts";
import type { SessionInfo } from "../services/types.ts";

const ORIGIN_ROOM = "11111111-1111-4111-8111-111111111111";
const TASK_ROOM = "22222222-2222-4222-8222-222222222222";
const MSG = "33333333-3333-4333-8333-333333333333";
const SOURCE_ROOM = "44444444-4444-4444-8444-444444444444";

function session(metadata: Record<string, unknown>): SessionInfo {
  return {
    id: "sess-1",
    agentType: "codex",
    workdir: "/tmp/work",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata,
  } as unknown as SessionInfo;
}

describe("sub-agent Discord reply routing", () => {
  it("keeps origin.roomId pointed at the user-facing Discord room, not the internal task room", () => {
    const origin = readOrigin(
      session({
        originRoomId: ORIGIN_ROOM,
        taskRoomId: TASK_ROOM,
        roomId: TASK_ROOM,
        messageId: MSG,
        source: "discord",
        label: "build game",
      }),
    );

    expect(origin?.roomId).toBe(ORIGIN_ROOM);
    expect(origin?.taskRoomId).toBe(TASK_ROOM);
  });

  it("falls back to legacy roomId when no distinct origin room was persisted", () => {
    const origin = readOrigin(
      session({
        roomId: ORIGIN_ROOM,
        messageId: MSG,
        source: "discord",
      }),
    );

    expect(origin?.roomId).toBe(ORIGIN_ROOM);
    expect(origin?.taskRoomId).toBe(ORIGIN_ROOM);
  });
});

describe("successor-session metadata sanitization (verify-retry / respawn)", () => {
  it("re-points the forwarded roomId from the task room to the resolvable origin room", () => {
    // This is the shape TASKS op=spawn_agent stamps: top-level roomId ===
    // taskRoomId (the minted task-room UUID), with the real chat room on
    // originRoomId. Forwarding {...meta} wholesale to a verify-retry successor
    // used to inherit roomId=taskRoomId, which has no live connector channel.
    const meta: Record<string, unknown> = {
      originRoomId: ORIGIN_ROOM,
      taskRoomId: TASK_ROOM,
      roomId: TASK_ROOM,
      messageId: MSG,
      source: "discord",
      label: "build game",
      initialTask: "do the thing",
      buildVerifyRetryCount: 1,
    };

    const sanitized = sanitizeSuccessorMetadata(meta);

    // Top-level roomId now points at the resolvable, user-facing room — the
    // same one readOrigin routes to — so downstream emitProgress / synthesis
    // land on a live channel without individually compensating.
    expect(sanitized.roomId).toBe(ORIGIN_ROOM);
    // Explicitly marked as an inherited-and-sanitized target.
    expect(sanitized[SUCCESSOR_ROOM_INHERITED_META_KEY]).toBe(true);
    // Fields that MUST carry over are preserved byte-for-byte.
    expect(sanitized.originRoomId).toBe(ORIGIN_ROOM);
    expect(sanitized.taskRoomId).toBe(TASK_ROOM);
    expect(sanitized.source).toBe("discord");
    expect(sanitized.label).toBe("build game");
    expect(sanitized.initialTask).toBe("do the thing");
    expect(sanitized.buildVerifyRetryCount).toBe(1);

    // The sanitized metadata routes through readOrigin identically — the fix
    // agrees with, rather than diverges from, the origin resolution.
    const origin = readOrigin(session(sanitized));
    expect(origin?.roomId).toBe(ORIGIN_ROOM);
    expect(origin?.taskRoomId).toBe(TASK_ROOM);
  });

  it("prefers sourceRoomId when no originRoomId is present", () => {
    const sanitized = sanitizeSuccessorMetadata({
      sourceRoomId: SOURCE_ROOM,
      taskRoomId: TASK_ROOM,
      roomId: TASK_ROOM,
      source: "discord",
    });
    expect(sanitized.roomId).toBe(SOURCE_ROOM);
    expect(sanitized[SUCCESSOR_ROOM_INHERITED_META_KEY]).toBe(true);
  });

  it("marks but does not re-point when roomId already equals the resolvable room", () => {
    // Task rooms opted out (origin === task room): nothing to re-point, but the
    // successor is still flagged so it's distinguishable from a first spawn.
    const sanitized = sanitizeSuccessorMetadata({
      originRoomId: ORIGIN_ROOM,
      taskRoomId: ORIGIN_ROOM,
      roomId: ORIGIN_ROOM,
      source: "discord",
    });
    expect(sanitized.roomId).toBe(ORIGIN_ROOM);
    expect(sanitized[SUCCESSOR_ROOM_INHERITED_META_KEY]).toBe(true);
  });

  it("leaves metadata untouched when nothing resolvable can be derived", () => {
    // No UUID room keys at all — no worse than the prior wholesale copy.
    const meta = { source: "discord", label: "x", initialTask: "y" };
    const sanitized = sanitizeSuccessorMetadata(meta);
    expect(sanitized).toEqual(meta);
    expect(sanitized[SUCCESSOR_ROOM_INHERITED_META_KEY]).toBeUndefined();
  });

  it("does not mutate the input metadata object", () => {
    const meta: Record<string, unknown> = {
      originRoomId: ORIGIN_ROOM,
      taskRoomId: TASK_ROOM,
      roomId: TASK_ROOM,
    };
    const sanitized = sanitizeSuccessorMetadata(meta);
    expect(meta.roomId).toBe(TASK_ROOM);
    expect(meta[SUCCESSOR_ROOM_INHERITED_META_KEY]).toBeUndefined();
    expect(sanitized).not.toBe(meta);
  });
});
