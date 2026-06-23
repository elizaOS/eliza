import { describe, expect, it, vi } from "vitest";
import {
  composeRoomDigest,
  runSupervisorTick,
  type SupervisorTaskView,
  statusEmoji,
} from "../../src/services/task-supervisor-service.js";

const ROOM_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ROOM_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function view(
  o: Partial<SupervisorTaskView> & { id: string },
): SupervisorTaskView {
  return {
    label: o.id,
    status: "active",
    activeSessions: 1,
    sessionLabel: null,
    origin: { roomId: ROOM_A, source: "telegram" },
    ...o,
  };
}

describe("composeRoomDigest (#8900)", () => {
  it("lists each task with a status emoji and running count, sorted by label", () => {
    const digest = composeRoomDigest([
      view({
        id: "build",
        label: "build-feature",
        status: "active",
        activeSessions: 2,
      }),
      view({
        id: "fix",
        label: "fix-bug",
        status: "validating",
        activeSessions: 0,
      }),
    ]);
    expect(digest).toContain("📡 Task update — 2 active");
    expect(digest).toContain(
      `${statusEmoji("active")} build-feature — active (2 running)`,
    );
    expect(digest).toContain(
      `${statusEmoji("validating")} fix-bug — validating`,
    );
    // sorted: build-feature before fix-bug
    expect(digest.indexOf("build-feature")).toBeLessThan(
      digest.indexOf("fix-bug"),
    );
  });
});

describe("runSupervisorTick (#8900)", () => {
  it("posts one digest per origin room", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    const res = await runSupervisorTick(
      [
        view({ id: "t1", origin: { roomId: ROOM_A, source: "telegram" } }),
        view({ id: "t2", origin: { roomId: ROOM_B, source: "discord" } }),
      ],
      send,
      seen,
    );
    expect(res.posted.sort()).toEqual([ROOM_A, ROOM_B].sort());
    expect(send).toHaveBeenCalledTimes(2);
    // target carries the room's own source
    const targets = send.mock.calls.map((c) => c[0]);
    expect(targets).toContainEqual({ source: "telegram", roomId: ROOM_A });
    expect(targets).toContainEqual({ source: "discord", roomId: ROOM_B });
  });

  it("dedups an unchanged digest on the next tick (no spam)", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    const views = [view({ id: "t1" })];
    const first = await runSupervisorTick(views, send, seen);
    expect(first.posted).toEqual([ROOM_A]);
    const second = await runSupervisorTick(views, send, seen);
    expect(second.posted).toEqual([]);
    expect(second.skipped).toEqual([ROOM_A]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-posts when a room's task state changes", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    await runSupervisorTick([view({ id: "t1", status: "active" })], send, seen);
    const res = await runSupervisorTick(
      [view({ id: "t1", status: "blocked" })],
      send,
      seen,
    );
    expect(res.posted).toEqual([ROOM_A]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips tasks with no origin room and non-live statuses", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    const res = await runSupervisorTick(
      [
        view({ id: "noroom", origin: null }),
        view({ id: "done", status: "done" }),
      ],
      send,
      seen,
    );
    expect(res.posted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("forgets a room once it has no live tasks, so a later task re-posts", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    await runSupervisorTick([view({ id: "t1" })], send, seen);
    // room goes quiet
    await runSupervisorTick([], send, seen);
    expect(seen.has(ROOM_A)).toBe(false);
    // same task reappears → re-posts (not deduped against the stale digest)
    const res = await runSupervisorTick([view({ id: "t1" })], send, seen);
    expect(res.posted).toEqual([ROOM_A]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a delivery failure doesn't poison dedup (retries next tick)", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("connector down"))
      .mockResolvedValueOnce(undefined);
    const seen = new Map<string, string>();
    const views = [view({ id: "t1" })];
    const first = await runSupervisorTick(views, send, seen);
    expect(first.posted).toEqual([]); // failed, not recorded
    expect(seen.has(ROOM_A)).toBe(false);
    const second = await runSupervisorTick(views, send, seen);
    expect(second.posted).toEqual([ROOM_A]); // retried successfully
  });
});
