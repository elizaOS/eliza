/**
 * Regression harness for the watchdog nag loop (live 2026-08-17 01:01–01:21Z):
 * grill → the grill's own reply resets lastActivity ("recovery") → recovery
 * cleared the prod memo → next stall re-grilled → infinite 4-minute babble
 * relayed to the user's room. Deterministic fakes drive the REAL
 * TaskWatchdogService through stall/recover/re-stall cycles.
 */

import { describe, expect, it, vi } from "vitest";
import { composeVerifyEscalationNotice } from "../services/orchestrator-task-service.js";
import {
  composeCapWarning,
  STALL_GRILL_PROMPT,
  TaskWatchdogService,
} from "../services/task-watchdog-service.js";

interface FakeSession {
  id: string;
  status: string;
  lastActivityAt: Date;
  metadata?: Record<string, unknown>;
}

function makeHarness(opts?: {
  tasks?: Array<{ status: string; latestSessionId: string | null }>;
}) {
  const sessions: FakeSession[] = [];
  const acp = {
    listSessions: async () => sessions.map((s) => ({ ...s })),
    sendToSession: vi.fn(async (sessionId: string) => {
      // The grill starts a real ACP turn; its reply refreshes activity —
      // exactly the "recovery" that used to re-arm the loop.
      const target = sessions.find((s) => s.id === sessionId);
      if (target) target.lastActivityAt = new Date();
      return { ok: true };
    }),
  };
  const taskService = opts?.tasks
    ? { listTasks: async () => opts.tasks }
    : undefined;
  const runtime = {
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SUBPROCESS_SERVICE") return acp;
      if (type === "ORCHESTRATOR_TASK_SERVICE") return taskService;
      return undefined;
    },
  };
  const watchdog = new TaskWatchdogService(runtime as never);
  return { sessions, acp, watchdog };
}

const STALL_MS = 180_000;

describe("watchdog nag loop (live regression)", () => {
  it("grills a session at most once per lifetime across stall→recover→re-stall cycles", async () => {
    const { sessions, acp, watchdog } = makeHarness();
    sessions.push({
      id: "s1",
      status: "running",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    });

    // First stall: exactly one grill.
    await watchdog.runOnce();
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
    expect(acp.sendToSession).toHaveBeenCalledWith("s1", STALL_GRILL_PROMPT);

    // The grill's reply refreshed activity — the session now looks recovered.
    await watchdog.runOnce();
    expect(watchdog.getStalledSessionIds()).toEqual([]);

    // It stalls again (the old code re-grilled here, forever, every ~4 min).
    const target = sessions.find((s) => s.id === "s1");
    if (target) target.lastActivityAt = new Date(Date.now() - STALL_MS - 1);
    await watchdog.runOnce();
    if (target) target.lastActivityAt = new Date(Date.now() - STALL_MS - 1);
    await watchdog.runOnce();
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
  });

  it("re-arms only when the session id leaves the list entirely (new session, new grill)", async () => {
    const { sessions, acp, watchdog } = makeHarness();
    sessions.push({
      id: "s1",
      status: "running",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    });
    await watchdog.runOnce();
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);

    // Session ends and a NEW session reuses nothing — fresh id gets its grill.
    sessions.length = 0;
    await watchdog.runOnce();
    sessions.push({
      id: "s2",
      status: "running",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    });
    await watchdog.runOnce();
    expect(acp.sendToSession).toHaveBeenCalledTimes(2);
    expect(acp.sendToSession).toHaveBeenLastCalledWith(
      "s2",
      STALL_GRILL_PROMPT,
    );
  });

  it("does not grill a session whose durable task idles by design (waiting_on_user)", async () => {
    const { sessions, acp, watchdog } = makeHarness({
      tasks: [{ status: "waiting_on_user", latestSessionId: "s1" }],
    });
    sessions.push({
      id: "s1",
      status: "running",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    });
    await watchdog.runOnce();
    expect(acp.sendToSession).not.toHaveBeenCalled();
    // Still surfaced as stalled for the provider — just not grilled.
    expect(watchdog.getStalledSessionIds()).toEqual(["s1"]);
  });

  it("fails open when no task record maps to the session (ad-hoc sessions still get their one grill)", async () => {
    const { sessions, acp, watchdog } = makeHarness({
      tasks: [{ status: "waiting_on_user", latestSessionId: "other" }],
    });
    sessions.push({
      id: "s1",
      status: "running",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    });
    await watchdog.runOnce();
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
  });

  it("grills an actively-working stalled task exactly once", async () => {
    const { sessions, acp, watchdog } = makeHarness({
      tasks: [{ status: "active", latestSessionId: "s1" }],
    });
    sessions.push({
      id: "s1",
      status: "running",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    });
    await watchdog.runOnce();
    await watchdog.runOnce();
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
  });
});

// ── cap-warning phrasing (model-voiced posts, deterministic fallback) ───────

const CAP_ROOM = "22222222-2222-4222-8222-222222222222";

// The phrase helper memoizes successful phrasings per agentId+cacheKey at
// module level; a unique agentId per harness keeps tests independent.
let capAgentSeq = 0;

function capHarness(useModel: ReturnType<typeof vi.fn>) {
  const sends: Array<{
    text: string;
    source: string;
    agentVoiced?: boolean;
  }> = [];
  const sessions: FakeSession[] = [
    {
      id: "s1",
      status: "running",
      lastActivityAt: new Date(),
      metadata: { roomId: CAP_ROOM, source: "discord", label: "wkr-1" },
    },
  ];
  const acp = {
    listSessions: async () => sessions.map((s) => ({ ...s })),
    sendToSession: vi.fn(async () => ({ ok: true })),
  };
  // 9/10 round-trips = 90% ≥ the 80% default warn ratio.
  const router = { getRoundTripCount: () => 9, getRoundTripCap: () => 10 };
  const runtime = {
    agentId: `00000000-0000-4000-8000-0000000000${(21 + capAgentSeq++)
      .toString()
      .padStart(2, "0")}`,
    character: { name: "Watcher", bio: ["test agent"] },
    getSetting: () => undefined,
    useModel,
    sendMessageToTarget: vi.fn(
      async (_target: unknown, content: (typeof sends)[number]) => {
        sends.push(content);
        return { id: "m", metadata: { platformMessageId: "pm" } };
      },
    ),
    getService: (type: string) => {
      if (type === "ACP_SUBPROCESS_SERVICE") return acp;
      if (type === "ACPX_SUB_AGENT_ROUTER") return router;
      return undefined;
    },
  };
  const watchdog = new TaskWatchdogService(runtime as never);
  return { watchdog, sends, useModel, runtime };
}

const CAP_FALLBACK = composeCapWarning(
  { id: "s1", kind: "round-trip", count: 9, limit: 10, ratio: 0.9 },
  "wkr-1",
);

describe("cap warning phrasing", () => {
  it("claims the warned slot BEFORE the model resolves (a concurrent tick cannot double-post) and stamps the phrased send agent-voiced", async () => {
    let resolveModel!: (text: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveModel = resolve;
    });
    const { watchdog, sends, useModel } = capHarness(vi.fn(() => pending));

    const first = watchdog.runOnce();
    // Drain microtasks until the model call is in flight (the warned slot must
    // already be claimed at this point).
    for (let i = 0; i < 40 && useModel.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(useModel).toHaveBeenCalledTimes(1);
    // A second tick while the phrase call is pending: the synchronous claim
    // must make it skip — no second model call, no second post.
    const second = watchdog.runOnce();
    resolveModel("Heads up: wkr-1 is close to its loop limit — 9 of 10.");
    await Promise.all([first, second]);

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe(
      "Heads up: wkr-1 is close to its loop limit — 9 of 10.",
    );
    expect(sends[0]?.agentVoiced).toBe(true);
  });

  it("uses the deterministic composeCapWarning fallback (all facts intact) when the model call rejects", async () => {
    const { watchdog, sends } = capHarness(
      vi.fn(async () => {
        throw new Error("no model");
      }),
    );
    await watchdog.runOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe(CAP_FALLBACK);
    expect(sends[0]?.text).toContain("wkr-1");
    expect(sends[0]?.text).toContain("9/10");
    // The fallback still rides as agent-voiced text on a converted send.
    expect(sends[0]?.agentVoiced).toBe(true);
    // One warning per approach: a later tick at the same ratio stays silent.
    await watchdog.runOnce();
    expect(sends).toHaveLength(1);
  });

  it("rejects phrased output that drops the label or leaks mechanism vocabulary, falling back", async () => {
    const missingLabel = capHarness(
      vi.fn(async () => "You are close to the limit, be careful."),
    );
    await missingLabel.watchdog.runOnce();
    expect(missingLabel.sends[0]?.text).toBe(CAP_FALLBACK);

    const bannedVocab = capHarness(
      vi.fn(async () => "wkr-1's session is close to its planner cap."),
    );
    await bannedVocab.watchdog.runOnce();
    expect(bannedVocab.sends[0]?.text).toBe(CAP_FALLBACK);
  });
});

// The escalation-notice composer lives in the task service but belongs to the
// same nag-loop family: the silent park was the invisible half of the loop.
describe("verify-escalation notice", () => {
  it("names the task, the attempt count, and the resolution path without internal ids", () => {
    const text = composeVerifyEscalationNotice("canon-clock build", {
      attempts: 3,
      summary: "Sub-agent explicitly admitted failure; provided no PATH output",
      missing: ["verbatim echo $PATH output", "diff of created file"],
    });
    expect(text).toContain("canon-clock build");
    expect(text).toContain("3 attempts");
    expect(text).toContain("verbatim echo $PATH output");
    expect(text).toContain("accept it or what to fix");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("caps the missing list at three and tolerates an empty one", () => {
    const many = composeVerifyEscalationNotice("t", {
      attempts: 3,
      summary: "s",
      missing: ["a", "b", "c", "d", "e"],
    });
    expect(many).toContain("a; b; c");
    expect(many).not.toContain("; d");
    const none = composeVerifyEscalationNotice("t", {
      attempts: 3,
      summary: "s",
      missing: [],
    });
    expect(none).not.toContain("couldn't confirm:");
  });
});
