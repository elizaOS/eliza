/**
 * Verifies composeRoomDigest (#8900).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  composeRoomDigest,
  isSupervisorStalled,
  runSupervisorTick,
  type SupervisorTaskView,
  statusEmoji,
  supervisorStalenessLabel,
  TaskSupervisorService,
  taskOldEnoughForDigest,
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

  it("damps a permanent delivery failure: remembers it undeliverable, no same-digest retry (ebdc4bc storm guard)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("connector down"));
    const seen = new Map<string, string>();
    const views = [view({ id: "t1" })];
    const first = await runSupervisorTick(views, send, seen);
    expect(first.posted).toEqual([]); // failed, nothing posted
    // A failed digest is REMEMBERED as `undeliverable:<digest>` so the loop does
    // not re-hammer a permanently-dead target every tick (the ~1871 warns/day
    // storm ebdc4bc fixed). It re-posts only when the digest CHANGES — i.e. on
    // a structural transition, not on the passage of idle time.
    expect(seen.get(ROOM_A)?.startsWith("undeliverable:")).toBe(true);
    const second = await runSupervisorTick(views, send, seen);
    expect(second.posted).toEqual([]); // same digest still dead → damped, not retried
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
  it("isSupervisorStalled trips only at the top (stalled) band", () => {
    expect(isSupervisorStalled(min(10), t0)).toBe(false);
    expect(isSupervisorStalled(min(44), t0)).toBe(false);
    expect(isSupervisorStalled(min(45), t0)).toBe(true);
    expect(isSupervisorStalled(min(90), t0)).toBe(true);
    expect(isSupervisorStalled(null, t0)).toBe(false);
    expect(isSupervisorStalled(0, t0)).toBe(false);
  });
  it("never folds idle/stall age into the room digest line", () => {
    const digest = composeRoomDigest([
      view({ id: "t1", label: "grind", status: "active" }),
    ]);
    expect(digest).toContain("grind — active (1 running)");
    expect(digest).not.toContain("idle");
    expect(digest).not.toContain("stalled");
  });
});

describe("stalled tasks never re-post to the room; they escalate to the owner", () => {
  function stalledRuntime(opts: { latestActivityAt: number | null }) {
    const reportError = vi.fn();
    const listTasks = vi.fn(async () => [
      {
        id: "t-stuck",
        title: "app-build",
        status: "active",
        activeSessionCount: 1,
        latestSessionLabel: "codex",
        latestActivityAt: opts.latestActivityAt,
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ]);
    const runtime = {
      getService: (type: string) =>
        type === "ORCHESTRATOR_TASK_SERVICE"
          ? {
              listTasks,
              getTaskOriginTarget: async () => ({
                roomId: ROOM_A,
                source: "discord",
              }),
            }
          : undefined,
      sendMessageToTarget: async () => ({
        kind: "delivered" as const,
        receipt: {
          providerMessageIds: ["digest-1"] as [string],
          acceptedAt: 1_780_000_000_000,
          persistence: { status: "persisted" as const, memoryIds: [] },
        },
        memories: [],
      }),
      getSetting: () => undefined,
      reportError,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never;
    return { runtime, reportError, listTasks };
  }

  it("an idle-timer tick does not re-post the digest (no group-channel stall spam)", async () => {
    const { runtime, listTasks } = stalledRuntime({
      latestActivityAt: Date.now() - 4 * 60_000,
    });
    const svc = await TaskSupervisorService.start(runtime);
    const first = await svc.runOnce();
    expect(first.posted).toEqual([ROOM_A]);
    // Idle deepens across band boundaries; structure is unchanged → deduped.
    listTasks.mockResolvedValue([
      {
        id: "t-stuck",
        title: "app-build",
        status: "active",
        activeSessionCount: 1,
        latestSessionLabel: "codex",
        latestActivityAt: Date.now() - 50 * 60_000,
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ]);
    const second = await svc.runOnce();
    expect(second.posted).toEqual([]);
    expect(second.skipped).toEqual([ROOM_A]);
    await svc.stop();
  });

  it("a task crossing the stalled band escalates to the owner ONCE via reportError, not to the room", async () => {
    const { runtime, reportError } = stalledRuntime({
      latestActivityAt: Date.now() - 50 * 60_000,
    });
    const svc = await TaskSupervisorService.start(runtime);
    const first = await svc.runOnce();
    // The first digest for the room may post (structural), but the stall itself
    // rides reportError — scope + task context, no room target.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "TaskSupervisorService.stalledTask",
      expect.any(Error),
      expect.objectContaining({ taskId: "t-stuck", status: "active" }),
    );
    // Digest text never carries the stall.
    expect(first.posted).toEqual([ROOM_A]);
    // Still stalled next tick → no second escalation, no re-post.
    const second = await svc.runOnce();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(second.posted).toEqual([]);
    await svc.stop();
  });

  it("a recovered task clears its escalation mark so a later re-stall re-reports", async () => {
    const { runtime, reportError, listTasks } = stalledRuntime({
      latestActivityAt: Date.now() - 50 * 60_000,
    });
    const svc = await TaskSupervisorService.start(runtime);
    await svc.runOnce();
    expect(reportError).toHaveBeenCalledTimes(1);
    // Fresh activity → recovered → mark cleared.
    listTasks.mockResolvedValue([
      {
        id: "t-stuck",
        title: "app-build",
        status: "active",
        activeSessionCount: 1,
        latestSessionLabel: "codex",
        latestActivityAt: Date.now() - 60_000,
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ]);
    await svc.runOnce();
    // Stalls again → re-escalates.
    listTasks.mockResolvedValue([
      {
        id: "t-stuck",
        title: "app-build",
        status: "active",
        activeSessionCount: 1,
        latestSessionLabel: "codex",
        latestActivityAt: Date.now() - 90 * 60_000,
        createdAt: new Date(Date.now() - 7_200_000).toISOString(),
      },
    ]);
    await svc.runOnce();
    expect(reportError).toHaveBeenCalledTimes(2);
    await svc.stop();
  });
});

describe("TaskSupervisorService.runOnce resilience", () => {
  function runtimeWith(taskSvc: unknown) {
    return {
      getService: (type: string) =>
        type === "ORCHESTRATOR_TASK_SERVICE" ? taskSvc : undefined,
      sendMessageToTarget: async () => ({
        kind: "delivered" as const,
        receipt: {
          providerMessageIds: ["supervisor-digest-1"] as [string],
          acceptedAt: 1_780_000_000_000,
          persistence: { status: "persisted" as const, memoryIds: [] },
        },
        memories: [],
      }),
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
            createdAt: new Date(Date.now() - 120_000).toISOString(),
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

describe("digest damping (uncoordinated-messages burst)", () => {
  // Unlike runtimeWith above, the supervisor stays ENABLED here:
  // noteTaskCompletion deliberately no-ops on a disabled supervisor, and
  // these tests exercise the note path. start() arms the unref'd interval
  // timer; svc.stop() clears it before the test ends.
  function enabledRuntimeWith(taskSvc: unknown) {
    return {
      getService: (type: string) =>
        type === "ORCHESTRATOR_TASK_SERVICE" ? taskSvc : undefined,
      sendMessageToTarget: async () => undefined,
      getSetting: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never;
  }

  it("gates the first digest on min task-age > tick interval (pure helper)", () => {
    const t0 = 1_000_000_000_000;
    const iso = (agoMs: number) => new Date(t0 - agoMs).toISOString();
    expect(taskOldEnoughForDigest(iso(10_000), t0, 45_000)).toBe(false);
    expect(taskOldEnoughForDigest(iso(45_000), t0, 45_000)).toBe(true);
    expect(taskOldEnoughForDigest(iso(90_000), t0, 45_000)).toBe(true);
    // Fail-open: an unparseable timestamp must not mute a task forever.
    expect(taskOldEnoughForDigest("not-a-date", t0, 45_000)).toBe(true);
  });

  it("runOnce posts no stale 'active' digest for a sub-tick-interval task", async () => {
    const svc = await TaskSupervisorService.start(
      enabledRuntimeWith({
        listTasks: async () => [
          {
            id: "young",
            title: "inline build",
            status: "active",
            activeSessionCount: 1,
            latestSessionLabel: "codex",
            createdAt: new Date(Date.now() - 5_000).toISOString(),
          },
        ],
        getTaskOriginTarget: async () => ({
          roomId: ROOM_A,
          source: "discord",
        }),
      }),
    );
    const result = await svc.runOnce();
    expect(result.posted).toEqual([]);
    await svc.stop();
  });

  it("suppresses the room digest in the tick window after a completion relay; only a CHANGE re-posts", async () => {
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    const first = await runSupervisorTick(
      [view({ id: "t1", status: "validating", recentlyRelayed: true })],
      send,
      seen,
    );
    expect(first.posted).toEqual([]);
    expect(first.skipped).toEqual([ROOM_A]);
    expect(send).not.toHaveBeenCalled();
    // Relay window over, digest unchanged → still silent (dedup owns it).
    const second = await runSupervisorTick(
      [view({ id: "t1", status: "validating" })],
      send,
      seen,
    );
    expect(second.posted).toEqual([]);
    // A real status transition still posts.
    const third = await runSupervisorTick(
      [view({ id: "t1", status: "blocked" })],
      send,
      seen,
    );
    expect(third.posted).toEqual([ROOM_A]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("freezes the line of a task held un-done after reporting completion (no retry-churn re-posts)", async () => {
    const digest = composeRoomDigest([
      view({
        id: "t1",
        label: "build-app",
        status: "active",
        activeSessions: 1,
        sessionLabel: "codex · acct-2",
        heldAfterCompletion: true,
      }),
    ]);
    expect(digest).toContain(`${statusEmoji("active")} build-app — active`);
    expect(digest).not.toContain("running");
    expect(digest).not.toContain("codex");
    // Verify-retry churn (new session label) no longer mutates the digest, so
    // the tick dedups instead of re-posting.
    const send = vi.fn(async () => undefined);
    const seen = new Map<string, string>();
    await runSupervisorTick(
      [
        view({
          id: "t1",
          label: "build-app",
          sessionLabel: "retry-1",
          heldAfterCompletion: true,
        }),
      ],
      send,
      seen,
    );
    const second = await runSupervisorTick(
      [
        view({
          id: "t1",
          label: "build-app",
          sessionLabel: "retry-2",
          heldAfterCompletion: true,
        }),
      ],
      send,
      seen,
    );
    expect(second.posted).toEqual([]);
    expect(second.skipped).toEqual([ROOM_A]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("noteTaskCompletion drives relay suppression through runOnce", async () => {
    const svc = await TaskSupervisorService.start(
      enabledRuntimeWith({
        listTasks: async () => [
          {
            id: "t-done",
            title: "site build",
            status: "validating",
            activeSessionCount: 0,
            latestSessionLabel: null,
            createdAt: new Date(Date.now() - 120_000).toISOString(),
          },
        ],
        getTaskOriginTarget: async () => ({
          roomId: ROOM_A,
          source: "discord",
        }),
      }),
    );
    svc.noteTaskCompletion("t-done");
    const result = await svc.runOnce();
    expect(result.posted).toEqual([]);
    expect(result.skipped).toEqual([ROOM_A]);
    await svc.stop();
  });
});
