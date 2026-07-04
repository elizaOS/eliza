/**
 * Verifies detectStalledSessions (#8901).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSessionSpendUsd,
  resetSessionSpendUsd,
} from "../../src/services/spend-allowance.js";
import {
  type CapWarning,
  type CapWarningView,
  composeCapWarning,
  detectCapWarnings,
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

describe("detectCapWarnings (#8901)", () => {
  it("flags a session at/over the round-trip warn ratio, not below", () => {
    const views: CapWarningView[] = [
      { id: "ok", status: "running", roundTripCount: 25, roundTripCap: 32 }, // 0.78
      { id: "hot", status: "running", roundTripCount: 26, roundTripCap: 32 }, // 0.81
    ];
    const warnings = detectCapWarnings(views, 0.8);
    expect(warnings.map((w) => w.id)).toEqual(["hot"]);
    expect(warnings[0]).toMatchObject({
      kind: "round-trip",
      count: 26,
      limit: 32,
    });
  });

  it("flags a session at/over the spend warn ratio, not below", () => {
    const views: CapWarningView[] = [
      { id: "cheap", status: "running", spendUsd: 0.7, spendCapUsd: 1 },
      { id: "pricey", status: "running", spendUsd: 0.9, spendCapUsd: 1 },
    ];
    const warnings = detectCapWarnings(views, 0.8);
    expect(warnings.map((w) => w.id)).toEqual(["pricey"]);
    expect(warnings[0].kind).toBe("spend");
  });

  it("flags exactly at the threshold (>= warnRatio)", () => {
    const views: CapWarningView[] = [
      { id: "rt", status: "running", roundTripCount: 8, roundTripCap: 10 },
      { id: "sp", status: "running", spendUsd: 0.8, spendCapUsd: 1 },
    ];
    expect(
      detectCapWarnings(views, 0.8)
        .map((w) => w.kind)
        .sort(),
    ).toEqual(["round-trip", "spend"]);
  });

  it("flags both kinds when one session crosses both caps", () => {
    const views: CapWarningView[] = [
      {
        id: "both",
        status: "running",
        roundTripCount: 30,
        roundTripCap: 32,
        spendUsd: 0.95,
        spendCapUsd: 1,
      },
    ];
    expect(
      detectCapWarnings(views, 0.8)
        .map((w) => w.kind)
        .sort(),
    ).toEqual(["round-trip", "spend"]);
  });

  it("never flags terminal sessions (they're done, not at risk)", () => {
    const views: CapWarningView[] = [
      {
        id: "done",
        status: "completed",
        roundTripCount: 99,
        roundTripCap: 32,
        spendUsd: 99,
        spendCapUsd: 1,
      },
    ];
    expect(detectCapWarnings(views, 0.8)).toEqual([]);
  });

  it("does not flag when a cap is absent/zero or spend is zero", () => {
    const views: CapWarningView[] = [
      { id: "no-cap", status: "running", roundTripCount: 99 },
      {
        id: "zero-cap",
        status: "running",
        roundTripCount: 99,
        roundTripCap: 0,
      },
      { id: "spend-off", status: "running", spendUsd: 5, spendCapUsd: 0 },
      { id: "no-spend", status: "running", spendUsd: 0, spendCapUsd: 1 },
    ];
    expect(detectCapWarnings(views, 0.8)).toEqual([]);
  });
});

describe("composeCapWarning (#8901)", () => {
  it("renders deterministic round-trip text", () => {
    const w: CapWarning = {
      id: "x",
      kind: "round-trip",
      ratio: 26 / 32,
      count: 26,
      limit: 32,
    };
    const text = composeCapWarning(w, "Lin");
    expect(text).toContain("Lin is at 26/32 round-trips (81%)");
    expect(text).toContain("STOP_AGENT");
  });

  it("renders deterministic spend text in dollars", () => {
    const w: CapWarning = {
      id: "x",
      kind: "spend",
      ratio: 0.85,
      count: 0.85,
      limit: 1,
    };
    expect(composeCapWarning(w, "Lin")).toContain(
      "spent $0.85 of its $1.00 budget (85%)",
    );
  });
});

describe("TaskWatchdogService cap warnings (#8901)", () => {
  const priorConfigPath = process.env.ELIZA_CONFIG_PATH;
  const priorCap = process.env.ELIZA_AGENT_SPEND_CAP_USD;

  beforeEach(() => {
    // Isolate readSpendCapUsd from any on-disk eliza config on the host.
    process.env.ELIZA_CONFIG_PATH = "/nonexistent-watchdog-cap-test.json";
    delete process.env.ELIZA_AGENT_SPEND_CAP_USD;
    resetSessionSpendUsd();
  });

  afterEach(() => {
    resetSessionSpendUsd();
    if (priorConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
    else process.env.ELIZA_CONFIG_PATH = priorConfigPath;
    if (priorCap === undefined) delete process.env.ELIZA_AGENT_SPEND_CAP_USD;
    else process.env.ELIZA_AGENT_SPEND_CAP_USD = priorCap;
  });

  type Post = { roomId?: string; source?: string; text: string };

  function capRuntime(opts: {
    acp: unknown;
    router?: {
      getRoundTripCount: (id: string) => number;
      getRoundTripCap: () => number;
    };
    posts?: Post[];
  }) {
    const send = opts.posts
      ? async (
          target: { source: string; roomId?: string },
          content: { text?: string; source?: string },
        ) => {
          opts.posts?.push({
            roomId: target.roomId,
            source: target.source,
            text: content.text ?? "",
          });
          return undefined;
        }
      : undefined;
    return {
      agentId: "agent-1",
      getSetting: () => undefined,
      getService: (t: string) => {
        if (t === "ACP_SUBPROCESS_SERVICE") return opts.acp;
        if (t === "ACPX_SUB_AGENT_ROUTER") return opts.router ?? null;
        return null;
      },
      ...(send ? { sendMessageToTarget: send } : {}),
    } as never;
  }

  function overCapSession() {
    return {
      id: "loop-1",
      status: "running",
      // Recent activity → NOT idle/stalled, so this exercises the cap path only.
      lastActivityAt: new Date(NOW - 1_000),
      metadata: { roomId: "room-b", source: "discord", label: "Lin" },
    };
  }

  it("warns the origin room once per (session,kind), then dedups", async () => {
    process.env.ELIZA_AGENT_SPEND_CAP_USD = "1.00";
    addSessionSpendUsd("loop-1", 0.85);
    const posts: Post[] = [];
    const sendToSession = vi.fn(async () => ({}));
    const acp = {
      listSessions: async () => [overCapSession()],
      sendToSession,
    };
    const router = {
      getRoundTripCap: () => 32,
      getRoundTripCount: (id: string) => (id === "loop-1" ? 26 : 0),
    };
    const svc = new TaskWatchdogService(capRuntime({ acp, router, posts }));

    await svc.runOnce(NOW);
    expect(sendToSession).not.toHaveBeenCalled(); // active, not stalled
    expect(posts).toHaveLength(2);
    expect(
      posts.every((p) => p.roomId === "room-b" && p.source === "discord"),
    ).toBe(true);
    expect(posts.some((p) => p.text.includes("round-trips"))).toBe(true);
    expect(posts.some((p) => p.text.includes("budget"))).toBe(true);
    expect(
      svc
        .getApproachingCapSessionIds()
        .map((w) => w.kind)
        .sort(),
    ).toEqual(["round-trip", "spend"]);

    // Second tick, same ratios → no re-post.
    await svc.runOnce(NOW + 1_000);
    expect(posts).toHaveLength(2);
  });

  it("re-warns after the round-trip ratio drops then climbs again", async () => {
    let rtCount = 26;
    const posts: Post[] = [];
    const acp = {
      listSessions: async () => [overCapSession()],
      sendToSession: vi.fn(async () => ({})),
    };
    const router = {
      getRoundTripCap: () => 32,
      getRoundTripCount: () => rtCount,
    };
    const svc = new TaskWatchdogService(capRuntime({ acp, router, posts }));

    await svc.runOnce(NOW);
    expect(posts.filter((p) => p.text.includes("round-trips"))).toHaveLength(1);

    rtCount = 10; // recovered (0.31)
    await svc.runOnce(NOW + 1_000);
    expect(svc.getApproachingCapSessionIds()).toEqual([]);

    rtCount = 28; // climbs again
    await svc.runOnce(NOW + 2_000);
    expect(posts.filter((p) => p.text.includes("round-trips"))).toHaveLength(2);
  });

  it("warns nothing when no cap signal is available, leaving the idle path intact", async () => {
    const sendToSession = vi.fn(async () => ({}));
    const acp = {
      listSessions: async () => [
        {
          id: "idle-1",
          status: "running",
          lastActivityAt: new Date(NOW - 200_000), // stalled
          metadata: { roomId: "room-a", source: "telegram", label: "Ada" },
        },
      ],
      sendToSession,
    };
    const posts: Post[] = [];
    const svc = new TaskWatchdogService(capRuntime({ acp, posts })); // no router, spend off
    const stalled = await svc.runOnce(NOW);
    expect(stalled.map((s) => s.id)).toEqual(["idle-1"]);
    expect(sendToSession).toHaveBeenCalledWith("idle-1", STALL_GRILL_PROMPT);
    expect(posts).toHaveLength(0);
    expect(svc.getApproachingCapSessionIds()).toEqual([]);
  });

  it("grills an idle session AND warns a separate over-cap session in one tick", async () => {
    process.env.ELIZA_AGENT_SPEND_CAP_USD = "1.00";
    addSessionSpendUsd("loop-1", 0.85);
    const posts: Post[] = [];
    const sendToSession = vi.fn(async () => ({}));
    const acp = {
      listSessions: async () => [
        {
          id: "idle-1",
          status: "running",
          lastActivityAt: new Date(NOW - 200_000), // stalled
          metadata: { roomId: "room-a", source: "telegram", label: "Ada" },
        },
        overCapSession(), // active but over round-trip + spend cap
      ],
      sendToSession,
    };
    const router = {
      getRoundTripCap: () => 32,
      getRoundTripCount: (id: string) => (id === "loop-1" ? 26 : 0),
    };
    const svc = new TaskWatchdogService(capRuntime({ acp, router, posts }));

    const stalled = await svc.runOnce(NOW);
    expect(stalled.map((s) => s.id)).toEqual(["idle-1"]);
    expect(sendToSession).toHaveBeenCalledWith("idle-1", STALL_GRILL_PROMPT);
    expect(svc.getStalledSessionIds()).toEqual(["idle-1"]);
    // idle-1 has 0 round-trips and 0 spend → no cap warning; only loop-1 warns.
    expect(posts.every((p) => p.roomId === "room-b")).toBe(true);
    expect(posts).toHaveLength(2);
    expect(
      svc.getApproachingCapSessionIds().every((w) => w.id === "loop-1"),
    ).toBe(true);
  });
});
