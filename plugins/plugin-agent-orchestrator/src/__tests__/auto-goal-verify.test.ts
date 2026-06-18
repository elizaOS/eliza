import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import {
  buildAutoVerifyCorrection,
  MAX_AUTO_VERIFY_ATTEMPTS,
  shouldAutoVerifyGoal,
} from "../services/goal-llm-verifier.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

describe("shouldAutoVerifyGoal", () => {
  const prev = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  afterEach(() => {
    if (prev === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = prev;
  });

  it("defaults on", () => {
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    expect(shouldAutoVerifyGoal()).toBe(true);
  });

  it("disables on explicit 0", () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    expect(shouldAutoVerifyGoal()).toBe(false);
  });

  it("stays on for any other value", () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
    expect(shouldAutoVerifyGoal()).toBe(true);
  });
});

describe("buildAutoVerifyCorrection", () => {
  it("lists each unmet criterion and asks for re-verification", () => {
    const msg = buildAutoVerifyCorrection(["tests pass", "no console usage"]);
    expect(msg).toContain("- tests pass");
    expect(msg).toContain("- no console usage");
    expect(msg).toContain("re-verify");
  });
});

/**
 * Drive the service through a fake ACP so the private auto-verify hook fires
 * off a real `task_complete` session event.
 */
type EventHandler = (sessionId: string, event: string, data: unknown) => void;

function makeFakeAcp() {
  let handler: EventHandler | undefined;
  const sent: Array<{ sessionId: string; text: string }> = [];
  const service = {
    onSessionEvent(cb: EventHandler) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    sendToSession: vi.fn(async (sessionId: string, text: string) => {
      sent.push({ sessionId, text });
      return { stopReason: "end_turn", finalText: "ok" };
    }),
    stopSession: vi.fn(async () => undefined),
  };
  return {
    service,
    sent,
    emit: (sessionId: string, event: string, data: unknown) =>
      handler?.(sessionId, event, data),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
  modelResponse: () => string,
): Record<string, unknown> {
  return {
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    useModel: vi.fn(async () => modelResponse()),
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
  };
}

async function seedTaskWithSession(
  store: OrchestratorTaskStore,
  acceptanceCriteria: string[],
): Promise<{ taskId: string; sessionId: string }> {
  const detail = await store.createTask({
    title: "t",
    goal: "do the thing",
    acceptanceCriteria,
  });
  const taskId = detail.task.id;
  const sessionId = "sess-1";
  const now = Date.now();
  await store.addSession({
    id: "row-1",
    taskId,
    sessionId,
    framework: "opencode",
    label: "Ada",
    originalTask: "do the thing",
    workdir: "/tmp/x",
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
  // Move the task to active so advanceTaskStatus → validating is allowed.
  await store.updateTask(taskId, { status: "active" });
  return { taskId, sessionId };
}

describe("auto goal verification on task_complete", () => {
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  });
  afterEach(() => {
    if (savedFlag === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedFlag;
  });

  it("marks the task done when the small model confirms all criteria", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    const runtime = makeRuntime(fake.service, () =>
      JSON.stringify({ passed: true, summary: "all good", missing: [] }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "done, tests pass" });
    await vi.waitFor(async () => {
      const doc = await store.getTask(taskId);
      expect(doc?.task.status).toBe("done");
    });
    expect(fake.sent).toHaveLength(0);
  });

  it("sends a corrective follow-up citing missing criteria on failure", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
      "no console usage",
    ]);
    const runtime = makeRuntime(fake.service, () =>
      JSON.stringify({
        passed: false,
        summary: "tests not run",
        missing: ["tests pass"],
      }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "I think it works" });
    await vi.waitFor(() => {
      expect(fake.service.sendToSession).toHaveBeenCalled();
    });
    const lastSent = fake.sent.at(-1);
    expect(lastSent?.text).toContain("tests pass");
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("active");
    expect(doc?.task.metadata.autoVerifyAttempts).toBe(1);
    expect(doc?.task.status).not.toBe("done");
  });

  it("escalates to waiting_on_user after the attempt cap", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    // Pre-load the counter at the cap so the next failure escalates.
    await store.updateTask(taskId, {
      metadata: { autoVerifyAttempts: MAX_AUTO_VERIFY_ATTEMPTS },
    });
    const runtime = makeRuntime(fake.service, () =>
      JSON.stringify({
        passed: false,
        summary: "nope",
        missing: ["tests pass"],
      }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "still broken" });
    await vi.waitFor(async () => {
      const doc = await store.getTask(taskId);
      expect(doc?.task.status).toBe("waiting_on_user");
    });
    expect(fake.service.sendToSession).not.toHaveBeenCalled();
  });

  it("does nothing extra for a task with no acceptance criteria", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, []);
    const useModel = vi.fn(async () => "{}");
    const runtime = {
      character: { name: "Tester" },
      databaseAdapter: undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      useModel,
      getService: (type: string) =>
        type === AcpService.serviceType ? fake.service : undefined,
    };
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "done" });
    // Give the fire-and-forget hook a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("validating");
    expect(useModel).not.toHaveBeenCalled();
    expect(fake.service.sendToSession).not.toHaveBeenCalled();
  });

  it("does not auto-verify when the flag is disabled", async () => {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    const useModel = vi.fn(async () => "{}");
    const runtime = {
      character: { name: "Tester" },
      databaseAdapter: undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      useModel,
      getService: (type: string) =>
        type === AcpService.serviceType ? fake.service : undefined,
    };
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("validating");
    expect(useModel).not.toHaveBeenCalled();
  });
});
