/**
 * Verifies the completion evaluator's verification-aware framing against the
 * REAL OrchestratorTaskService + in-memory store: a relayed completion for a
 * task still in `validating` carries a verification-pending note, a task
 * knocked back by a failed verification carries a provisional note, and a
 * verified-`done` (or record-less) completion relays exactly as before.
 */
import type { Memory, MessageHandlerResult, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { subAgentCompletionResponseEvaluator } from "../evaluators/sub-agent-completion.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type { OrchestratorTaskStatus } from "../services/orchestrator-task-types.js";

const UUID_A = "00000000-0000-0000-0000-000000000001" as UUID;

function makeCompletion(text: string, sessionId?: string): Memory {
  return {
    id: UUID_A,
    entityId: UUID_A,
    agentId: UUID_A,
    roomId: UUID_A,
    content: {
      text,
      source: "sub_agent",
      metadata: {
        subAgent: true,
        subAgentEvent: "task_complete",
        subAgentDeliverable: "The answer is 42.",
        ...(sessionId ? { subAgentSessionId: sessionId } : {}),
      },
    },
  } as unknown as Memory;
}

function makeHandler(): MessageHandlerResult {
  return {
    processMessage: "RESPOND",
    thought: "",
    plan: { contexts: [], reply: "" },
  } as unknown as MessageHandlerResult;
}

/** A real service + store with one task (in `status`) and one session bound to
 * it, plus a runtime whose getService resolves the real service. */
async function makeWorld(opts: {
  status: OrchestratorTaskStatus;
  autoVerifyAttempts?: number;
  disclosedRisks?: string[];
}): Promise<{ runtime: Record<string, unknown>; sessionId: string }> {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const detail = await store.createTask({
    title: "t",
    goal: "answer the question",
    acceptanceCriteria: [],
  });
  const sessionId = "framing-sess-1";
  const now = Date.now();
  await store.addSession({
    id: "framing-row-1",
    taskId: detail.task.id,
    sessionId,
    framework: "opencode",
    label: "Ada",
    originalTask: "answer the question",
    workdir: "",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: true,
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
  const metadata: Record<string, unknown> = {};
  if (opts.autoVerifyAttempts !== undefined) {
    metadata.autoVerifyAttempts = opts.autoVerifyAttempts;
  }
  if (opts.disclosedRisks !== undefined) {
    metadata.completionResiduals = {
      status: "clean",
      residuals: [],
      disclosedRisks: opts.disclosedRisks,
      checkedAt: Date.now(),
    };
  }
  await store.updateTask(detail.task.id, {
    status: opts.status,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
  const runtimeBag: Record<string, unknown> = {
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
  };
  const service = new OrchestratorTaskService(runtimeBag as never, { store });
  runtimeBag.getService = (type: string) =>
    type === OrchestratorTaskService.serviceType ? service : undefined;
  return { runtime: runtimeBag, sessionId };
}

async function relayFor(world: {
  runtime: Record<string, unknown>;
  sessionId: string;
}): Promise<string> {
  const result = await subAgentCompletionResponseEvaluator.evaluate({
    runtime: world.runtime,
    message: makeCompletion("done.", world.sessionId),
    messageHandler: makeHandler(),
  } as unknown as Parameters<
    typeof subAgentCompletionResponseEvaluator.evaluate
  >[0]);
  return typeof result.reply === "string" ? result.reply : "";
}

describe("sub-agent completion: verification-aware framing", () => {
  it("frames a relay as verification-pending while the task is validating", async () => {
    const world = await makeWorld({ status: "validating" });
    const reply = await relayFor(world);
    expect(reply).toContain("The answer is 42.");
    expect(reply).toContain("verification of this result is still running");
  });

  it("frames a relay as provisional after a failed verification (re-engage in flight)", async () => {
    const world = await makeWorld({ status: "active", autoVerifyAttempts: 1 });
    const reply = await relayFor(world);
    expect(reply).toContain("The answer is 42.");
    expect(reply).toContain("verification found gaps");
  });

  it("frames a relay as provisional when verification exhausted to waiting_on_user", async () => {
    const world = await makeWorld({
      status: "waiting_on_user",
      autoVerifyAttempts: 3,
    });
    const reply = await relayFor(world);
    expect(reply).toContain("verification found gaps");
  });

  it("relays a verified done task with no extra framing", async () => {
    const world = await makeWorld({ status: "done" });
    const reply = await relayFor(world);
    expect(reply).toBe("The answer is 42.");
  });

  it("surfaces worker-disclosed residual risks as caveats on a done relay (F2)", async () => {
    const world = await makeWorld({
      status: "done",
      disclosedRisks: ["migration not run on prod", "flaky retry loop"],
    });
    const reply = await relayFor(world);
    expect(reply).toContain("The answer is 42.");
    expect(reply).toContain(
      "the worker flagged: migration not run on prod; flaky retry loop",
    );
  });

  it("combines the pending-verification note with disclosed-risk caveats", async () => {
    const world = await makeWorld({
      status: "validating",
      disclosedRisks: ["needs a prod smoke test"],
    });
    const reply = await relayFor(world);
    expect(reply).toContain("verification of this result is still running");
    expect(reply).toContain("the worker flagged: needs a prod smoke test");
  });

  it("preserves current behavior when no durable record backs the session", async () => {
    const world = await makeWorld({ status: "validating" });
    const result = await subAgentCompletionResponseEvaluator.evaluate({
      runtime: world.runtime,
      // No subAgentSessionId → no task lookup possible.
      message: makeCompletion("done."),
      messageHandler: makeHandler(),
    } as unknown as Parameters<
      typeof subAgentCompletionResponseEvaluator.evaluate
    >[0]);
    expect(result.reply).toBe("The answer is 42.");
  });

  it("preserves current behavior when the orchestrator service is not registered", async () => {
    const result = await subAgentCompletionResponseEvaluator.evaluate({
      runtime: {
        getService: () => undefined,
      },
      message: makeCompletion("done.", "some-session"),
      messageHandler: makeHandler(),
    } as unknown as Parameters<
      typeof subAgentCompletionResponseEvaluator.evaluate
    >[0]);
    expect(result.reply).toBe("The answer is 42.");
  });
});
