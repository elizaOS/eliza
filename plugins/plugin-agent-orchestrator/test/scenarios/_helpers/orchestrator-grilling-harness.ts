/**
 * Shared harness for the orchestrator grilling scenarios.
 *
 * The grilling/verification loop is internal: it fires when the
 * OrchestratorTaskService receives a `task_complete` session event from the ACP
 * subprocess, runs the LLM verifier over the task's acceptance criteria, and
 * either marks the task `done` or sends a corrective "grill" back to the
 * sub-agent. To exercise that loop deterministically inside the scenario runner
 * (no real coding-agent subprocess), we:
 *
 *   1. construct the real OrchestratorTaskService over an in-memory store,
 *   2. inject a SCRIPTED ACP (captures the grill re-prompts, lets us emit
 *      `task_complete` events on demand), and
 *   3. proxy the scenario's live runtime so the verifier's `useModel` call hits
 *      whatever model the scenario wants (the live model for a live-lane
 *      scenario, or a capturing stub for a deterministic one).
 *
 * Mirrors the unit harness in `__tests__/auto-goal-verify.test.ts`, lifted to
 * run against a real runtime under the scenario CLI so it emits the JSON report
 * + run viewer + native JSONL that AGENTS.md requires.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { AcpService } from "../../../src/services/acp-service";
import { OrchestratorTaskService } from "../../../src/services/orchestrator-task-service";
import { OrchestratorTaskStore } from "../../../src/services/orchestrator-task-store";

export type EventHandler = (
  sessionId: string,
  event: string,
  data: unknown,
) => void;

/** A scripted stand-in for AcpService: records grill re-prompts and lets the
 * scenario emit `task_complete` events as if a sub-agent reported done. */
export function makeScriptedAcp() {
  let handler: EventHandler | undefined;
  const sent: Array<{ sessionId: string; text: string }> = [];
  const service = {
    onSessionEvent(cb: EventHandler) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    sendToSession: async (sessionId: string, text: string) => {
      sent.push({ sessionId, text });
      return { stopReason: "end_turn", finalText: "ok" };
    },
    stopSession: async () => undefined,
    getChangedPaths: () => [],
    getSession: async () => undefined,
    updateSessionMetadata: async () => undefined,
  };
  return {
    service,
    sent,
    emit: (sessionId: string, event: string, data: unknown) =>
      handler?.(sessionId, event, data),
  };
}

/** Wrap the scenario's real runtime so `getService(ACP)` returns the scripted
 * ACP and `useModel` is routed to `modelOverride` (the verifier model). Every
 * other runtime member passes through to the live runtime untouched. */
export function makeGrillingRuntime(
  base: IAgentRuntime,
  acp: ReturnType<typeof makeScriptedAcp>["service"],
  modelOverride: (...args: unknown[]) => Promise<unknown>,
): IAgentRuntime {
  const target =
    base && typeof base === "object" ? base : ({} as IAgentRuntime);
  return new Proxy(target, {
    get(target, prop, receiver) {
      if (prop === "getService") {
        return (type: string) => {
          if (type === AcpService.serviceType) return acp;
          const getService = (target as Partial<IAgentRuntime>).getService;
          return typeof getService === "function"
            ? getService.call(target, type as never)
            : undefined;
        };
      }
      if (prop === "useModel") return modelOverride;
      if (prop === "agentId") {
        return Reflect.get(target, prop, receiver) ?? "scenario-agent";
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as IAgentRuntime;
}

/** Seed an in-memory task + a single ready session, advanced to `active` so the
 * completion→validating→verify path is allowed. Returns ids + the store. */
export async function seedActiveTask(acceptanceCriteria: string[]): Promise<{
  store: OrchestratorTaskStore;
  taskId: string;
  sessionId: string;
}> {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const detail = await store.createTask({
    title: "Implement the widget",
    goal: "implement the widget and prove it works",
    acceptanceCriteria,
    roomId: "scenario-room-grill",
    taskRoomId: "scenario-task-room-grill",
    worldId: "scenario-world",
  });
  const taskId = detail.task.id;
  const sessionId = "scenario-sess-1";
  const now = Date.now();
  await store.addSession({
    id: "row-1",
    taskId,
    sessionId,
    framework: "opencode",
    label: "Ada",
    originalTask: "implement the widget",
    workdir: "/tmp/widget",
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
  await store.updateTask(taskId, { status: "active" });
  return { store, taskId, sessionId };
}

export { OrchestratorTaskService };

/** Poll `predicate` until it returns true or the deadline passes. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 100 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
