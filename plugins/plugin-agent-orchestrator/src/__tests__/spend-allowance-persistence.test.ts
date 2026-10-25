import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import {
  addSessionSpendUsd,
  configureSpendLedger,
  createTaskStoreSpendLedger,
  decideSpendAuthorization,
  getSessionSpendUsd,
  hydrateSessionSpendUsd,
  resetSessionSpendUsd,
} from "../services/spend-allowance.js";

describe("spend allowance persistence", () => {
  afterEach(() => {
    configureSpendLedger(null);
    resetSessionSpendUsd();
  });

  it("commits a debit before a restarted session can authorize more spend", async () => {
    const sessionId = "spend-restart-session";
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const task = await store.createTask({
      title: "Spend persistence proof",
      goal: "keep automatic spend within the configured cap",
      acceptanceCriteria: ["the debit survives restart"],
    });
    const now = Date.now();
    await store.addSession({
      id: "spend-restart-row",
      taskId: task.task.id,
      sessionId,
      framework: "codex",
      label: "Spend proof",
      originalTask: "deploy within the cap",
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

    configureSpendLedger(createTaskStoreSpendLedger(store));
    await addSessionSpendUsd(sessionId, 0.67);

    resetSessionSpendUsd(sessionId);
    expect(await hydrateSessionSpendUsd(sessionId)).toBe(0.67);

    const nextDecision = decideSpendAuthorization({
      command: "containers.create",
      risk: "paid",
      capUsd: 0.67,
      alreadySpentUsd: getSessionSpendUsd(sessionId),
    });
    expect(nextDecision).toMatchObject({
      autoAuthorize: false,
      reason: "over-cap",
    });
  });
});
