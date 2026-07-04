/**
 * Verifies shouldAutoVerifyGoal.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import {
  buildAutoVerifyCorrection,
  MAX_AUTO_VERIFY_ATTEMPTS,
  shouldAutoVerifyGoal,
} from "../services/goal-llm-verifier.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import {
  type AttemptReflection,
  MAX_ATTEMPT_REFLECTIONS,
} from "../services/orchestrator-task-types.js";

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
  it("lists each unmet criterion, names the proof to produce, and asks to re-report with it", () => {
    const msg = buildAutoVerifyCorrection(["tests pass", "no console usage"]);
    expect(msg).toContain("- tests pass");
    expect(msg).toContain("- no console usage");
    // Strengthened contract: demand concrete proof per criterion and a
    // re-report that INCLUDES it (issue: evidence-demanding critic).
    expect(msg).toMatch(/proof to produce:/);
    expect(msg).toMatch(/report complete AGAIN/i);
    expect(msg).toMatch(/INCLUDE that proof inline/i);
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
    // First failure → attempt 1 → collegial phrasing + evidence checklist.
    expect(lastSent?.text).toMatch(/did not confirm the task is complete/);
    expect(lastSent?.text).toMatch(/Evidence checklist/i);
    expect(lastSent?.text).not.toMatch(/FINAL ATTEMPT/);
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("active");
    expect(doc?.task.metadata.autoVerifyAttempts).toBe(1);
    expect(doc?.task.status).not.toBe("done");
  });

  it("escalates the corrective tone on the second failure (attempt 2)", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    // One prior failed attempt already recorded, so the next correction is
    // attempt 2 — the call site must pass attempts + 1 to the grill builder.
    await store.updateTask(taskId, { metadata: { autoVerifyAttempts: 1 } });
    const runtime = makeRuntime(fake.service, () =>
      JSON.stringify({
        passed: false,
        summary: "still no proof",
        missing: ["tests pass"],
      }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: "trust me it works" });
    await vi.waitFor(() => {
      expect(fake.service.sendToSession).toHaveBeenCalled();
    });
    const lastSent = fake.sent.at(-1);
    // Pointed/socratic attempt-2 wording, not the attempt-1 collegial message.
    expect(lastSent?.text).toMatch(/attempt 2/);
    expect(lastSent?.text).toMatch(/ALREADY FAILED/);
    expect(lastSent?.text).toMatch(/Exactly which command did you run/);
    expect(lastSent?.text).toMatch(/Evidence checklist/i);
    const doc = await store.getTask(taskId);
    expect(doc?.task.metadata.autoVerifyAttempts).toBe(2);
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

/** Runner-agnostic poll (Bun's vitest shim lacks `vi.waitFor`). */
async function until(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 3000,
    stepMs = 10,
  }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("until: condition not met within timeout");
}

/** A runtime whose `useModel` spy is exposed so tests can assert call count and
 *  inspect the prompt the text judge received. */
function makeSpyRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
  modelResponse: () => string,
): {
  runtime: Record<string, unknown>;
  useModel: ReturnType<typeof vi.fn>;
} {
  const useModel = vi.fn(async () => modelResponse());
  return {
    runtime: {
      character: { name: "Tester" },
      databaseAdapter: undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: () => undefined,
      useModel,
      getService: (type: string) =>
        type === AcpService.serviceType ? acp : undefined,
    },
    useModel,
  };
}

const VALID_ENVELOPE = JSON.stringify(
  {
    diffSummary: "added the feature",
    filesChanged: ["src/x.ts"],
    testResults: [{ command: "bun test", exitCode: 0, summary: "all green" }],
    screenshotPaths: [],
    acceptanceCriteriaStatus: [
      { criterion: "tests pass", met: true, evidence: "bun test exit 0" },
    ],
    residualRisks: [],
  },
  null,
  2,
);

// Missing `testResults` → present-but-malformed.
const MALFORMED_ENVELOPE = JSON.stringify(
  {
    diffSummary: "added the feature",
    filesChanged: ["src/x.ts"],
    screenshotPaths: [],
    acceptanceCriteriaStatus: [
      { criterion: "tests pass", met: true, evidence: "x" },
    ],
    residualRisks: [],
  },
  null,
  2,
);

const fence = (json: string): string => `done.\n\n\`\`\`json\n${json}\n\`\`\``;

describe("completion envelope gate (#8895)", () => {
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

  it("valid fenced envelope → metadata.completionEnvelope populated + judge grills the contract", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    const { runtime, useModel } = makeSpyRuntime(fake.service, () =>
      JSON.stringify({ passed: true, summary: "confirmed", missing: [] }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", { response: fence(VALID_ENVELOPE) });
    await until(
      async () => (await store.getTask(taskId))?.task.status === "done",
    );

    const doc = await store.getTask(taskId);
    const envelope = doc?.task.metadata.completionEnvelope as
      | { filesChanged: string[]; testResults: unknown[] }
      | undefined;
    expect(envelope?.filesChanged).toEqual(["src/x.ts"]);
    expect(envelope?.testResults).toHaveLength(1);
    // The judge received a summarizeEnvelope-grounded evidence string, not prose.
    const judgePrompt = useModel.mock.calls[0]?.[1] as
      | { prompt?: string }
      | undefined;
    expect(judgePrompt?.prompt).toContain("criteria: 1/1 met");
  });

  it("malformed envelope → structural block BEFORE the judge + re-prompt", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    const { runtime, useModel } = makeSpyRuntime(fake.service, () =>
      JSON.stringify({ passed: true, summary: "n/a", missing: [] }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", {
      response: fence(MALFORMED_ENVELOPE),
    });
    await until(() => fake.service.sendToSession.mock.calls.length > 0);

    // The model judge was never consulted — the structural gate ran first.
    expect(useModel).not.toHaveBeenCalled();
    const doc = await store.getTask(taskId);
    expect(doc?.events.some((e) => e.eventType === "envelope_invalid")).toBe(
      true,
    );
    const lastSent = fake.sent.at(-1);
    expect(lastSent?.text).toContain(
      "did not include a valid CompletionEnvelope",
    );
    expect(lastSent?.text).toContain("testResults must be an array");
    expect(doc?.task.status).toBe("active");
    expect(doc?.task.metadata.autoVerifyAttempts).toBe(1);
  });

  it("absent envelope → back-compat fallback to the text judge", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    const { runtime, useModel } = makeSpyRuntime(fake.service, () =>
      JSON.stringify({ passed: true, summary: "confirmed", missing: [] }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", {
      response: "I finished the work and all tests pass.",
    });
    await until(
      async () => (await store.getTask(taskId))?.task.status === "done",
    );

    // No envelope present → the existing text-judge path still runs.
    expect(useModel).toHaveBeenCalledTimes(1);
    const doc = await store.getTask(taskId);
    expect(doc?.task.metadata.completionEnvelope).toBeUndefined();
  });

  it("malformed envelope at the attempt cap → parks waiting_on_user (no infinite loop)", async () => {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    await store.updateTask(taskId, {
      metadata: { autoVerifyAttempts: MAX_AUTO_VERIFY_ATTEMPTS },
    });
    const { runtime, useModel } = makeSpyRuntime(fake.service, () =>
      JSON.stringify({ passed: true, summary: "n/a", missing: [] }),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();

    fake.emit(sessionId, "task_complete", {
      response: fence(MALFORMED_ENVELOPE),
    });
    await until(
      async () =>
        (await store.getTask(taskId))?.task.status === "waiting_on_user",
    );

    expect(fake.service.sendToSession).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
  });
});

/**
 * A richer fake ACP for the #8898 independent verifier: supports multiple event
 * subscribers, records spawnSession calls, and pushes a configurable verifier
 * `task_complete` for any session spawned with `metadata.source` of
 * `independent-verifier`.
 */
function makeVerifierAcp(verifierResponse: () => string) {
  type Handler = (sessionId: string, event: string, data: unknown) => void;
  const handlers = new Set<Handler>();
  const sent: Array<{ sessionId: string; text: string }> = [];
  const spawned: Array<{
    approvalPreset?: string;
    metadata?: Record<string, unknown>;
    workdir?: string;
  }> = [];
  const stopped: string[] = [];
  let counter = 0;
  const emit = (sessionId: string, event: string, data: unknown) => {
    for (const handler of [...handlers]) handler(sessionId, event, data);
  };
  const service = {
    onSessionEvent(cb: Handler) {
      handlers.add(cb);
      return () => {
        handlers.delete(cb);
      };
    },
    sendToSession: vi.fn(async (sessionId: string, text: string) => {
      sent.push({ sessionId, text });
      return { stopReason: "end_turn", finalText: "ok" };
    }),
    stopSession: vi.fn(async (sessionId: string) => {
      stopped.push(sessionId);
    }),
    getSession: vi.fn(async () => undefined),
    spawnSession: vi.fn(
      async (opts: {
        approvalPreset?: string;
        metadata?: Record<string, unknown>;
        workdir?: string;
        initialTask?: string;
      }) => {
        spawned.push({
          approvalPreset: opts.approvalPreset,
          metadata: opts.metadata,
          workdir: opts.workdir,
        });
        counter += 1;
        const sessionId = `verifier-${counter}`;
        if (opts.metadata?.source === "independent-verifier") {
          // Emit AFTER spawnSession resolves and the caller subscribes.
          setTimeout(() => {
            emit(sessionId, "task_complete", { response: verifierResponse() });
          }, 0);
        }
        return { sessionId, workdir: opts.workdir ?? "/tmp/x" };
      },
    ),
  };
  return { service, sent, spawned, stopped, emit };
}

const CHANGE_SET = {
  changedFiles: ["src/x.ts"],
  diffStat: "1 file changed",
  diff: "diff --git a/src/x.ts b/src/x.ts",
  truncated: false,
  capturedAt: Date.now(),
};

async function seedCodeChangeTask(
  store: OrchestratorTaskStore,
  acceptanceCriteria: string[],
): Promise<{ taskId: string; sessionId: string }> {
  const seeded = await seedTaskWithSession(store, acceptanceCriteria);
  // A real change set on the reporting session makes hasCodeChanges true so the
  // independent verifier is gated ON.
  await store.updateSession(seeded.sessionId, {
    metadata: { lastChangeSet: CHANGE_SET },
  });
  return seeded;
}

const FAILING_VERIFIER_ENVELOPE = `verified.\n\n\`\`\`json\n${JSON.stringify({
  diffSummary: "re-ran",
  filesChanged: [],
  testResults: [{ command: "bun test", exitCode: 1, summary: "2 failed" }],
  screenshotPaths: [],
  acceptanceCriteriaStatus: [
    { criterion: "tests pass", met: false, evidence: "2 failed" },
  ],
  residualRisks: [],
})}\n\`\`\``;

const INCONCLUSIVE_VERIFIER_ENVELOPE = `verified.\n\n\`\`\`json\n${JSON.stringify(
  {
    diffSummary: "could not confirm",
    filesChanged: [],
    testResults: [],
    screenshotPaths: [],
    acceptanceCriteriaStatus: [],
    residualRisks: [],
  },
)}\n\`\`\``;

describe("independent read-only verifier (#8898)", () => {
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

  it("spawns a read-only verifier with approvalPreset 'verifier'; a falsely-green completion is BLOCKED", async () => {
    const fake = makeVerifierAcp(() => FAILING_VERIFIER_ENVELOPE);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedCodeChangeTask(store, [
      "tests pass",
    ]);
    const useModel = vi.fn(async () =>
      JSON.stringify({ passed: true, summary: "should not be reached" }),
    );
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

    // Worker falsely claims green via a valid envelope.
    fake.emit(sessionId, "task_complete", { response: fence(VALID_ENVELOPE) });
    await until(() => fake.service.sendToSession.mock.calls.length > 0);

    // AC1: the verifier was spawned read-only, ephemeral, and torn down.
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]?.approvalPreset).toBe("verifier");
    expect(fake.spawned[0]?.metadata?.source).toBe("independent-verifier");
    expect(fake.spawned[0]?.metadata?.keepAliveAfterComplete).toBe(false);
    expect(fake.stopped).toContain("verifier-1");

    // AC2/AC3: execution disproved the claim → blocked with distinct provenance.
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).not.toBe("done");
    const failure = doc?.events.find(
      (e) => e.eventType === "validation_failed",
    );
    expect(failure?.data?.verifier).toBe("independent-acp-verifier");
    // The cheap text judge was never reached — execution verdict is authoritative.
    expect(useModel).not.toHaveBeenCalled();
  });

  it("an inconclusive verifier verdict keeps the task validating (no false promotion)", async () => {
    const fake = makeVerifierAcp(() => INCONCLUSIVE_VERIFIER_ENVELOPE);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedCodeChangeTask(store, [
      "tests pass",
    ]);
    const useModel = vi.fn(async () =>
      JSON.stringify({ passed: true, summary: "should not be reached" }),
    );
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

    fake.emit(sessionId, "task_complete", { response: fence(VALID_ENVELOPE) });
    await until(
      async () =>
        (await store.getTask(taskId))?.events.some(
          (e) => e.eventType === "independent_verify_inconclusive",
        ) === true,
    );

    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("validating");
    expect(doc?.task.status).not.toBe("done");
    expect(useModel).not.toHaveBeenCalled();
  });

  it("does NOT spawn a verifier for a task with no code changes (gated)", async () => {
    const fake = makeVerifierAcp(() => FAILING_VERIFIER_ENVELOPE);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    // No lastChangeSet seeded → hasCodeChanges false → verifier gated off.
    const { taskId, sessionId } = await seedTaskWithSession(store, [
      "tests pass",
    ]);
    const useModel = vi.fn(async () =>
      JSON.stringify({ passed: true, summary: "confirmed", missing: [] }),
    );
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

    fake.emit(sessionId, "task_complete", { response: "done, all tests pass" });
    await until(
      async () => (await store.getTask(taskId))?.task.status === "done",
    );

    expect(fake.spawned).toHaveLength(0);
    expect(useModel).toHaveBeenCalledTimes(1);
  });
});

/**
 * Reflexion persistence (#8899): drive the REAL `autoVerifyCompletion` append
 * path (orchestrator-task-service.ts) so each failed verdict writes a
 * `{attempt, missing, summary}` post-mortem into `metadata.attemptReflections`,
 * the buffer caps at {@link MAX_ATTEMPT_REFLECTIONS} (dropping the oldest), and
 * malformed persisted entries are sanitized by `readAttemptReflections`. The
 * shipped render leaf is already covered by goal-prompt.test.ts; this exercises
 * the stateful loop end to end with no hand-injected reflection array.
 */
describe("attempt reflection persistence (#8899)", () => {
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

  /**
   * Seed a task (optionally with prior metadata), wire a fake ACP whose verifier
   * model always returns `verdict`, then fire a single `task_complete` so the
   * real auto-verify hook runs. Returns the store + ids so the caller can poll
   * the persisted `metadata.attemptReflections`.
   */
  async function driveOneVerify(opts: {
    acceptanceCriteria: string[];
    seedMetadata?: Record<string, unknown>;
    verdict: { passed: boolean; summary: string; missing: string[] };
  }): Promise<{ store: OrchestratorTaskStore; taskId: string }> {
    const fake = makeFakeAcp();
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { taskId, sessionId } = await seedTaskWithSession(
      store,
      opts.acceptanceCriteria,
    );
    if (opts.seedMetadata) {
      await store.updateTask(taskId, { metadata: opts.seedMetadata });
    }
    const runtime = makeRuntime(fake.service, () =>
      JSON.stringify(opts.verdict),
    );
    const service = new OrchestratorTaskService(runtime as never, { store });
    await service.start();
    fake.emit(sessionId, "task_complete", { response: "I think it works" });
    return { store, taskId };
  }

  async function reflectionsOf(
    store: OrchestratorTaskStore,
    taskId: string,
  ): Promise<AttemptReflection[]> {
    const doc = await store.getTask(taskId);
    const raw = doc?.task.metadata?.attemptReflections;
    return Array.isArray(raw) ? (raw as AttemptReflection[]) : [];
  }

  it("records a post-mortem for the first failed verification", async () => {
    const { store, taskId } = await driveOneVerify({
      acceptanceCriteria: ["tests pass"],
      verdict: {
        passed: false,
        summary: "tests not run",
        missing: ["tests pass"],
      },
    });
    await vi.waitFor(async () => {
      expect(await reflectionsOf(store, taskId)).toEqual([
        { attempt: 1, summary: "tests not run", missing: ["tests pass"] },
      ]);
    });
  });

  it("accumulates a second post-mortem in attempt order", async () => {
    const { store, taskId } = await driveOneVerify({
      acceptanceCriteria: ["tests pass"],
      seedMetadata: {
        autoVerifyAttempts: 1,
        attemptReflections: [
          { attempt: 1, summary: "first failure", missing: ["tests pass"] },
        ],
      },
      verdict: {
        passed: false,
        summary: "second failure",
        missing: ["tests pass"],
      },
    });
    await vi.waitFor(async () => {
      expect(await reflectionsOf(store, taskId)).toEqual([
        { attempt: 1, summary: "first failure", missing: ["tests pass"] },
        { attempt: 2, summary: "second failure", missing: ["tests pass"] },
      ]);
    });
  });

  it("caps the buffer at MAX_ATTEMPT_REFLECTIONS, dropping the oldest", async () => {
    const seeded: AttemptReflection[] = Array.from(
      { length: MAX_ATTEMPT_REFLECTIONS },
      (_unused, index) => ({
        attempt: index + 1,
        summary: `reflection-${index + 1}`,
        missing: ["tests pass"],
      }),
    );
    const { store, taskId } = await driveOneVerify({
      acceptanceCriteria: ["tests pass"],
      // Under the auto-verify attempt cap so the append branch (not the
      // waiting_on_user escalation) runs and exercises `.slice(-MAX)`.
      seedMetadata: { autoVerifyAttempts: 1, attemptReflections: seeded },
      verdict: {
        passed: false,
        summary: "reflection-new",
        missing: ["tests pass"],
      },
    });
    await vi.waitFor(async () => {
      const reflections = await reflectionsOf(store, taskId);
      expect(reflections).toHaveLength(MAX_ATTEMPT_REFLECTIONS);
      // Oldest dropped, newest appended.
      expect(reflections.map((r) => r.summary)).toEqual([
        "reflection-2",
        "reflection-3",
        "reflection-4",
        "reflection-5",
        "reflection-new",
      ]);
    });
  });

  it("sanitizes malformed persisted reflections through the real append", async () => {
    const { store, taskId } = await driveOneVerify({
      acceptanceCriteria: ["tests pass"],
      seedMetadata: {
        autoVerifyAttempts: 1,
        attemptReflections: [
          { bad: true },
          "garbage",
          { attempt: "x", summary: 1 },
          { attempt: 1, summary: "real prior", missing: ["a", 2] },
        ],
      },
      verdict: {
        passed: false,
        summary: "new failure",
        missing: ["tests pass"],
      },
    });
    await vi.waitFor(async () => {
      expect(await reflectionsOf(store, taskId)).toEqual([
        // Malformed rows dropped; the non-string missing entry (2) filtered out.
        { attempt: 1, summary: "real prior", missing: ["a"] },
        { attempt: 2, summary: "new failure", missing: ["tests pass"] },
      ]);
    });
  });

  it("does not record a reflection when verification passes", async () => {
    const { store, taskId } = await driveOneVerify({
      acceptanceCriteria: ["tests pass"],
      verdict: { passed: true, summary: "all good", missing: [] },
    });
    await vi.waitFor(async () => {
      const doc = await store.getTask(taskId);
      expect(doc?.task.status).toBe("done");
    });
    expect(await reflectionsOf(store, taskId)).toEqual([]);
  });

  it("does not append a reflection past the attempt cap (escalation)", async () => {
    const seeded: AttemptReflection[] = [
      { attempt: 1, summary: "first", missing: ["tests pass"] },
      { attempt: 2, summary: "second", missing: ["tests pass"] },
    ];
    const { store, taskId } = await driveOneVerify({
      acceptanceCriteria: ["tests pass"],
      seedMetadata: {
        autoVerifyAttempts: MAX_AUTO_VERIFY_ATTEMPTS,
        attemptReflections: seeded,
      },
      verdict: { passed: false, summary: "nope", missing: ["tests pass"] },
    });
    await vi.waitFor(async () => {
      const doc = await store.getTask(taskId);
      expect(doc?.task.status).toBe("waiting_on_user");
    });
    // The escalation branch parks for a human and leaves the buffer untouched.
    expect(await reflectionsOf(store, taskId)).toEqual(seeded);
  });
});
