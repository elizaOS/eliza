/**
 * Verifies composeRoomDigest (#8900).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  composeRoomDigest,
  runSupervisorTick,
  type SupervisorTaskView,
  statusEmoji,
  supervisorStalenessLabel,
  TaskSupervisorService,
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

  it("re-posts a STUCK task when its staleness band escalates (not deduped silent)", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    // First tick: task is fresh (no staleness) → posts.
    const first = await runSupervisorTick(
      [view({ id: "t1", status: "active" })],
      send,
      seen,
    );
    expect(first.posted).toEqual([ROOM_A]);
    // Same task, same status/sessions, but now idle 8m+ (a stall) → the digest
    // changes and it RE-POSTS, instead of being deduped into silence.
    const second = await runSupervisorTick(
      [view({ id: "t1", status: "active", staleness: "⏳ idle 8m+" })],
      send,
      seen,
    );
    expect(second.posted).toEqual([ROOM_A]);
  });
});

describe("supervisorStalenessLabel (#8900)", () => {
  const t0 = 1_000_000_000_000;
  const min = (m: number) => t0 - m * 60_000;
  it("returns undefined when fresh or activity time is unknown", () => {
    expect(supervisorStalenessLabel(min(1), t0)).toBeUndefined();
    expect(supervisorStalenessLabel(null, t0)).toBeUndefined();
    expect(supervisorStalenessLabel(undefined, t0)).toBeUndefined();
    expect(supervisorStalenessLabel(0, t0)).toBeUndefined();
  });
  it("escalates through coarse bands as idle time grows", () => {
    expect(supervisorStalenessLabel(min(4), t0)).toBe("⏳ idle 3m+");
    expect(supervisorStalenessLabel(min(10), t0)).toBe("⏳ idle 8m+");
    expect(supervisorStalenessLabel(min(25), t0)).toBe("⏳ idle 20m+");
    expect(supervisorStalenessLabel(min(90), t0)).toBe("⚠️ stalled 45m+");
  });
  it("folds into the digest line", () => {
    const digest = composeRoomDigest([
      view({
        id: "t1",
        label: "grind",
        status: "active",
        staleness: "⏳ idle 8m+",
      }),
    ]);
    expect(digest).toContain("grind — active (1 running) ⏳ idle 8m+");
  });
});

describe("TaskSupervisorService.runOnce resilience", () => {
  function runtimeWith(taskSvc: unknown) {
    return {
      getService: (type: string) =>
        type === "ORCHESTRATOR_TASK_SERVICE" ? taskSvc : undefined,
      sendMessageToTarget: async () => undefined,
      // Supervisor disabled → start() does not arm the interval timer.
      getSetting: (k: string) =>
        k === "ELIZA_ORCHESTRATOR_SUPERVISOR" ? "0" : undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never;
  }

  it("swallows a throwing task service instead of rejecting (no unhandled rejection per tick)", async () => {
    const svc = await TaskSupervisorService.start(
      runtimeWith({
        listTasks: async () => {
          throw new Error("db exploded");
        },
        getTaskOriginTarget: async () => null,
      }),
    );
    await expect(svc.runOnce()).resolves.toEqual({ posted: [], skipped: [] });
    await svc.stop();
  });

  it("still posts a digest on a healthy tick", async () => {
    const svc = await TaskSupervisorService.start(
      runtimeWith({
        listTasks: async () => [
          {
            id: "t1",
            title: "Alpha",
            status: "active",
            activeSessionCount: 1,
            latestSessionLabel: "codex",
          },
        ],
        getTaskOriginTarget: async () => ({
          roomId: ROOM_A,
          source: "telegram",
        }),
      }),
    );
    const result = await svc.runOnce();
    expect(result.posted).toEqual([ROOM_A]);
    await svc.stop();
  });
});
