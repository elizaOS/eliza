import { describe, expect, it } from "vitest";
import { readOrigin } from "../services/sub-agent-router.ts";
import type { SessionInfo } from "../services/types.ts";

const ORIGIN_ROOM = "11111111-1111-4111-8111-111111111111";
const TASK_ROOM = "22222222-2222-4222-8222-222222222222";
const MSG = "33333333-3333-4333-8333-333333333333";

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
