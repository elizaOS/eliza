import { describe, expect, it, vi } from "vitest";
import { handleBlocked } from "../services/swarm-decision-loop.js";
import type {
  SwarmCoordinatorContext,
  TaskContext,
} from "../services/swarm-coordinator.js";

function createTaskContext(): TaskContext {
  return {
    threadId: "thread-1",
    sessionId: "session-1",
    agentType: "claude",
    label: "research-1",
    originalTask: "Research the issue",
    workdir: "/tmp/work",
    status: "active",
    decisions: [],
    autoResolvedCount: 0,
    registeredAt: Date.now(),
    lastActivityAt: Date.now(),
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
  };
}

function createContext(taskCtx: TaskContext): SwarmCoordinatorContext {
  return {
    runtime: {} as never,
    ptyService: {
      sendKeysToSession: vi.fn(async () => undefined),
      sendToSession: vi.fn(async () => undefined),
    } as never,
    taskRegistry: {
      appendEvent: vi.fn(async () => undefined),
    } as never,
    tasks: new Map([[taskCtx.sessionId, taskCtx]]),
    inFlightDecisions: new Set(),
    pendingDecisions: new Map(),
    pendingTurnComplete: new Map(),
    lastBlockedPromptFingerprint: new Map(),
    pendingBlocked: new Map(),
    lastSeenOutput: new Map(),
    lastToolNotification: new Map(),
    isPaused: false,
    sharedDecisions: [],
    getSwarmContext: () => "",
    swarmCompleteNotified: false,
    broadcast: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    sendChatMessage: vi.fn(() => true),
    log: vi.fn(),
    getSupervisionLevel: () => "autonomous",
    getAgentDecisionCallback: () => null,
    getSwarmCompleteCallback: () => null,
    recordDecision: vi.fn(async () => undefined),
    syncTaskContext: vi.fn(async () => undefined),
  } as unknown as SwarmCoordinatorContext;
}

describe("handleBlocked", () => {
  it("accepts Claude bypass permission prompts with option 2 plus enter", async () => {
    const taskCtx = createTaskContext();
    const ctx = createContext(taskCtx);

    await handleBlocked(ctx, taskCtx.sessionId, taskCtx, {
      promptInfo: {
        type: "permission",
        prompt: "Bypass Permissions confirmation",
      },
      autoResponded: false,
    });

    expect(ctx.ptyService?.sendKeysToSession).toHaveBeenCalledWith(
      "session-1",
      ["2", "enter"],
    );
    expect(ctx.ptyService?.sendToSession).not.toHaveBeenCalled();
    expect(ctx.recordDecision).toHaveBeenCalledWith(
      taskCtx,
      expect.objectContaining({
        decision: "auto_resolved",
        response: "keys:2,enter",
      }),
    );
    expect(ctx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "blocked_auto_resolved",
        data: expect.objectContaining({
          strategy: "adapter_suggested_response",
        }),
      }),
    );
  });
});
