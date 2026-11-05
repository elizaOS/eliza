/**
 * Regression tests: `postUserMessage` must read the `sendToSession` prompt
 * receipt before reporting a user message as forwarded. `sendPrompt`
 * resolves with a `PromptResult` for cancelled/stopped/errored turns
 * instead of throwing, so a resolve alone is not proof the relay turn
 * ran — the same classification `undeliveredReason` applies to follow-up
 * prompts in api/agent-routes.ts. Before the fix, `postUserMessage`
 * discarded the receipt and put every resolved session in `forwardedTo`;
 * only a throw landed in `failedTo` with the session marked send_failed.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type { PromptResult } from "../services/types.js";

const SESSION_ID = "relay-session";

function makeReceipt(overrides: Partial<PromptResult>): PromptResult {
  return {
    sessionId: SESSION_ID,
    response: "",
    finalText: "",
    stopReason: "end_turn",
    durationMs: 1,
    ...overrides,
  };
}

function stubAcp(
  sendToSession: (sessionId: string, input: string) => Promise<PromptResult>,
) {
  return {
    getSession: async (sessionId: string) => ({
      sessionId,
      status: "ready",
    }),
    sendToSession,
  };
}

function makeRuntime(acp: unknown): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : null,
    hasService: () => false,
    services: new Map(),
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

async function postWithAcp(acp: unknown) {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const tasks = new OrchestratorTaskService(makeRuntime(acp), { store });
  const task = await store.createTask({
    title: "Relay receipt",
    goal: "steer the worker",
    acceptanceCriteria: [],
    roomId: "relay-room",
    worldId: "relay-world",
  });
  const now = Date.now();
  await store.addSession({
    id: "relay-row",
    taskId: task.task.id,
    sessionId: SESSION_ID,
    framework: "codex",
    label: "Relay worker",
    originalTask: "steer the worker",
    workdir: "/tmp",
    status: "ready",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  const result = await tasks.postUserMessage(
    task.task.id,
    "also update the README",
  );
  const stored = (await store.getTask(task.task.id))?.sessions.find(
    (s) => s.sessionId === SESSION_ID,
  );
  return { result, storedStatus: stored?.status };
}

describe("postUserMessage relay delivery receipt", () => {
  it("forwards when the relay turn settles end_turn", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () => makeReceipt({})),
    );
    expect(result?.forwardedTo).toEqual([SESSION_ID]);
    expect(result?.failedTo).toEqual([]);
    expect(storedStatus).toBe("ready");
  });

  it("does not forward when the relay turn settles error", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () =>
        makeReceipt({ stopReason: "error", error: "acpx prompt failed" }),
      ),
    );
    expect(result?.forwardedTo).toEqual([]);
    expect(result?.failedTo).toEqual([
      { sessionId: SESSION_ID, error: "acpx prompt failed" },
    ]);
    expect(storedStatus).toBe("send_failed");
  });

  it("does not forward when the receipt carries an error", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () => makeReceipt({ error: "acpx prompt failed" })),
    );
    expect(result?.forwardedTo).toEqual([]);
    expect(result?.failedTo).toEqual([
      { sessionId: SESSION_ID, error: "acpx prompt failed" },
    ]);
    expect(storedStatus).toBe("send_failed");
  });

  it("does not forward when the relay turn is cancelled", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () => makeReceipt({ stopReason: "cancelled" })),
    );
    expect(result?.forwardedTo).toEqual([]);
    expect(result?.failedTo).toEqual([
      { sessionId: SESSION_ID, error: "turn settled cancelled" },
    ]);
    expect(storedStatus).toBe("send_failed");
  });

  it("does not forward when the relay turn is stopped", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () => makeReceipt({ stopReason: "stopped" })),
    );
    expect(result?.forwardedTo).toEqual([]);
    expect(result?.failedTo).toEqual([
      { sessionId: SESSION_ID, error: "turn settled stopped" },
    ]);
    expect(storedStatus).toBe("send_failed");
  });

  it("does not forward on a terminal failure receipt", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () =>
        makeReceipt({
          stopReason: "error",
          error: "agent process exited",
          terminalFailure: {
            kind: "process_exit",
            message: "agent process exited",
            transient: false,
          },
        }),
      ),
    );
    expect(result?.forwardedTo).toEqual([]);
    expect(result?.failedTo).toEqual([
      { sessionId: SESSION_ID, error: "agent process exited" },
    ]);
    expect(storedStatus).toBe("send_failed");
  });

  it("still collects a thrown send failure", async () => {
    const { result, storedStatus } = await postWithAcp(
      stubAcp(async () => {
        throw new Error("session is gone");
      }),
    );
    expect(result?.forwardedTo).toEqual([]);
    expect(result?.failedTo).toEqual([
      { sessionId: SESSION_ID, error: "session is gone" },
    ]);
    expect(storedStatus).toBe("send_failed");
  });
});
