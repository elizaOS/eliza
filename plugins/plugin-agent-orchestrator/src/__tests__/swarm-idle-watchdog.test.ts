import { describe, expect, it, vi } from "vitest";
import { scanIdleSessions } from "../services/swarm-idle-watchdog.js";

describe("scanIdleSessions", () => {
  it("marks a missing PTY completed when a completion summary was already captured", async () => {
    const taskCtx = {
      threadId: "thread-test",
      sessionId: "pty-test",
      label: "agent-test",
      status: "tool_running",
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
      completionSummary: "Built the result and verified it.",
    };
    const ctx = {
      tasks: new Map([[taskCtx.sessionId, taskCtx]]),
      ptyService: {
        getSession: vi.fn(() => undefined),
      },
      inFlightDecisions: new Set(),
      pendingTurnComplete: new Map(),
      pendingBlocked: new Map(),
      sharedDecisions: [],
      swarmCompleteNotified: false,
      log: vi.fn(),
      recordDecision: vi.fn(),
      broadcast: vi.fn(),
      sendChatMessage: vi.fn(),
      syncTaskContext: vi.fn(),
      runtime: {},
      taskRegistry: {
        getThread: vi.fn(async () => null),
      },
      getSwarmCompleteCallback: vi.fn(() => undefined),
    };

    await scanIdleSessions(ctx as never);

    expect(taskCtx.status).toBe("completed");
    expect(ctx.syncTaskContext).toHaveBeenCalledWith(taskCtx);
    expect(ctx.recordDecision).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(ctx.sendChatMessage).toHaveBeenCalledWith(
        "Built the result and verified it.",
        "task-agent",
      );
    });
  });
});
