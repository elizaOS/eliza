import { describe, expect, it, vi } from "vitest";
import {
  detectStalledSessions,
  STALL_GRILL_PROMPT,
  TaskWatchdogService,
  type WatchdogSessionView,
} from "../../src/services/task-watchdog-service.js";

const NOW = 1_000_000;
const STALL = 180_000;

describe("detectStalledSessions (#8901)", () => {
  it("flags active sessions idle beyond the threshold", () => {
    const sessions: WatchdogSessionView[] = [
      { id: "busy", status: "running", lastActivityMs: NOW - 10_000 },
      { id: "stuck", status: "running", lastActivityMs: NOW - 200_000 },
    ];
    const stalled = detectStalledSessions(sessions, NOW, STALL);
    expect(stalled.map((s) => s.id)).toEqual(["stuck"]);
    expect(stalled[0].idleMs).toBe(200_000);
  });

  it("never flags terminal sessions (they're done, not stalled)", () => {
    const sessions: WatchdogSessionView[] = [
      { id: "done", status: "completed", lastActivityMs: NOW - 9_999_999 },
      { id: "err", status: "error", lastActivityMs: NOW - 9_999_999 },
    ];
    expect(detectStalledSessions(sessions, NOW, STALL)).toEqual([]);
  });
});

describe("TaskWatchdogService.runOnce (#8901)", () => {
  function makeRuntime(acp: unknown) {
    return {
      agentId: "agent-1",
      getSetting: () => undefined,
      getService: (t: string) => (t === "ACP_SUBPROCESS_SERVICE" ? acp : null),
    } as never;
  }

  it("prods each stalled session once, then surfaces it as stalled", async () => {
    const sendToSession = vi.fn(async () => ({}));
    const acp = {
      listSessions: async () => [
        {
          id: "stuck",
          status: "running",
          lastActivityAt: new Date(NOW - 200_000),
        },
        { id: "ok", status: "running", lastActivityAt: new Date(NOW - 1_000) },
      ],
      sendToSession,
    };
    const svc = new TaskWatchdogService(makeRuntime(acp));

    const stalled = await svc.runOnce(NOW);
    expect(stalled.map((s) => s.id)).toEqual(["stuck"]);
    expect(sendToSession).toHaveBeenCalledTimes(1);
    expect(sendToSession).toHaveBeenCalledWith("stuck", STALL_GRILL_PROMPT);
    expect(svc.getStalledSessionIds()).toEqual(["stuck"]);

    // Second tick, still stalled → does NOT re-prod (grill once).
    await svc.runOnce(NOW + 1_000);
    expect(sendToSession).toHaveBeenCalledTimes(1);
  });

  it("clears the prod flag when a session recovers, so a later stall re-grills", async () => {
    const sendToSession = vi.fn(async () => ({}));
    let activity = NOW - 200_000; // stalled
    const acp = {
      listSessions: async () => [
        { id: "s", status: "running", lastActivityAt: new Date(activity) },
      ],
      sendToSession,
    };
    const svc = new TaskWatchdogService(makeRuntime(acp));
    await svc.runOnce(NOW); // prod #1
    expect(sendToSession).toHaveBeenCalledTimes(1);

    activity = NOW; // recovered
    await svc.runOnce(NOW + 1_000);
    expect(svc.getStalledSessionIds()).toEqual([]);

    activity = NOW - 200_000; // stalls again
    await svc.runOnce(NOW + 2_000);
    expect(sendToSession).toHaveBeenCalledTimes(2); // re-grilled
  });
});
