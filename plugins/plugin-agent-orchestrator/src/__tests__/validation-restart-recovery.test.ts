/**
 * Startup re-arm for validation orphaned by a restart.
 *
 * Verification runs in-process: a restart landing between `task_complete`
 * (status → `validating`) and the verifier's verdict killed the verifier with
 * the process and nothing re-armed it, so the task row sat `validating`
 * forever (live 2026-08-24, task a7136dab — the relay sweep re-delivered the
 * completion message but the status never resolved). These tests drive the
 * REAL OrchestratorTaskService + memory store through
 * sweepOrphanedValidations; the only stub is the judge model response:
 *
 *  - an orphaned validating task is re-armed from the durable task_complete
 *    event and promoted to done on a passing verdict;
 *  - a fail-closed gate (residuals, real dirty git workspace) parks instead
 *    of promoting — parking with the evented notice is acceptable, silence
 *    is not;
 *  - a task with no durable completion evidence is resolved explicitly
 *    (evented park), never left silently validating;
 *  - a second sweep over already-resolved tasks no-ops (idempotence);
 *  - a multi-lane task re-arms ONLY the verdict-less lane;
 *  - a re-armed promotion never duplicates an already-delivered completion
 *    relay (the delivered ledger is untouched and nothing user-facing posts);
 *  - a lane whose ACP session is still live is left alone.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { MAX_AUTO_VERIFY_ATTEMPTS } from "../services/goal-llm-verifier.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

const PASS_VERDICT = JSON.stringify({
  passed: true,
  summary: "All criteria verified.",
  missing: [],
});

function makeFakeAcp(
  sessions: Map<string, Record<string, unknown>> = new Map(),
) {
  return {
    onSessionEvent: vi.fn(() => () => undefined),
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    getSessions: vi.fn(async () => [...sessions.values()]),
    getOrchestratorOwnedArtifacts: vi.fn(() => []),
    sendToSession: vi.fn(async () => ({
      stopReason: "end_turn",
      finalText: "ok",
    })),
    stopSession: vi.fn(async () => undefined),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>,
  opts: {
    modelResponse?: () => string;
    router?: Record<string, unknown>;
  } = {},
) {
  return {
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    reportError: vi.fn(),
    useModel: vi.fn(async () => (opts.modelResponse ?? (() => PASS_VERDICT))()),
    getService: (type: string) => {
      if (type === AcpService.serviceType) return acp;
      if (type === "ACPX_SUB_AGENT_ROUTER") return opts.router;
      return undefined;
    },
  };
}

async function addSession(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId: string,
  overrides: {
    metadata?: Record<string, unknown>;
    taskDelivered?: boolean;
    completionSummary?: string;
    workdir?: string;
    registeredAt?: number;
  } = {},
): Promise<void> {
  const now = overrides.registeredAt ?? Date.now();
  await store.addSession({
    id: `row-${sessionId}`,
    taskId,
    sessionId,
    framework: "eliza-code",
    label: sessionId,
    originalTask: `--- User Task ---\nBuild it\n\n--- Script tasks ---\nx`,
    workdir: overrides.workdir ?? "/tmp/validation-restart-does-not-exist",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: overrides.taskDelivered ?? true,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: overrides.metadata ?? {},
    ...(overrides.completionSummary
      ? { completionSummary: overrides.completionSummary }
      : {}),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
}

async function addCompletionEvent(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId: string,
  response: string,
): Promise<void> {
  await store.addEvent({
    id: randomUUID(),
    taskId,
    sessionId,
    eventType: "task_complete",
    summary: "Task complete",
    data: { response },
    timestamp: Date.now(),
    createdAt: new Date().toISOString(),
  });
}

async function makeValidatingTask(
  store: OrchestratorTaskStore,
  opts: { criteria?: string[]; metadata?: Record<string, unknown> } = {},
): Promise<string> {
  const detail = await store.createTask({
    title: "Restart Orphan",
    goal: "build the page",
    acceptanceCriteria: opts.criteria ?? ["the page renders"],
  });
  const taskId = detail.task.id;
  if (opts.metadata) {
    const doc = await store.getTask(taskId);
    await store.updateTask(taskId, {
      metadata: { ...(doc?.task.metadata ?? {}), ...opts.metadata },
    });
  }
  await store.updateTask(taskId, { status: "validating" });
  return taskId;
}

describe("orphaned-validation restart recovery sweep", () => {
  it("re-arms an orphaned validating task and promotes it on a passing verdict", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskId = await makeValidatingTask(store);
    await addSession(store, taskId, "sess-1");
    await addCompletionEvent(
      store,
      taskId,
      "sess-1",
      "The page is built and renders. All checks passed.",
    );
    const service = new OrchestratorTaskService(
      makeRuntime(makeFakeAcp()) as never,
      { store },
    );

    const result = await service.sweepOrphanedValidations();

    expect(result).toMatchObject({ reArmed: 1, resolved: 0 });
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("done");
    // The re-arm is on the durable timeline, and the verdict flowed through
    // the normal validation path.
    const eventTypes = doc?.events.map((e) => e.eventType) ?? [];
    expect(eventTypes).toContain("verify_restart_rearmed");
    expect(eventTypes).toContain("validation_passed");
  });

  it("parks (never promotes) when the fail-closed residuals gate blocks the re-armed verification", async () => {
    const prevGate = process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;
    process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = "1";
    const workdir = mkdtempSync(join(tmpdir(), "validation-restart-git-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: workdir, stdio: "ignore" });
      git("init");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(workdir, "a.txt"), "committed\n");
      git("add", ".");
      git("commit", "-m", "seed");
      // Uncommitted residual work: the gate must block promotion.
      writeFileSync(join(workdir, "b.txt"), "uncommitted\n");

      const store = new OrchestratorTaskStore({ backend: "memory" });
      const taskId = await makeValidatingTask(store, {
        // At the attempt cap: the failing gate parks instead of re-engaging.
        metadata: { autoVerifyAttempts: MAX_AUTO_VERIFY_ATTEMPTS },
      });
      await addSession(store, taskId, "sess-1", { workdir });
      await addCompletionEvent(store, taskId, "sess-1", "Done, ship it.");
      const service = new OrchestratorTaskService(
        makeRuntime(makeFakeAcp()) as never,
        { store },
      );

      const result = await service.sweepOrphanedValidations();

      expect(result).toMatchObject({ reArmed: 1, resolved: 0 });
      const doc = await store.getTask(taskId);
      // Parked with the evented escalation — never promoted, never silent.
      expect(doc?.task.status).toBe("waiting_on_user");
      const eventTypes = doc?.events.map((e) => e.eventType) ?? [];
      expect(eventTypes).toContain("verify_restart_rearmed");
      // At the attempt cap the failing gate parks through the shared
      // escalation path; the exhausted event carries the residuals verifier
      // as its provenance.
      const exhausted = doc?.events.find(
        (e) => e.eventType === "auto_verify_exhausted",
      );
      expect(exhausted?.data?.verifier).toBe("completion-residuals");
      expect(doc?.task.metadata?.verifyParkedAt).toBeTruthy();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      if (prevGate === undefined)
        delete process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;
      else process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = prevGate;
    }
  });

  it("resolves a task with no durable completion evidence via an evented park, never leaving it validating", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskId = await makeValidatingTask(store);
    // The session reported (taskDelivered) but the completion text is gone:
    // no task_complete event, no pending relay, no completionSummary.
    await addSession(store, taskId, "sess-1", { taskDelivered: true });
    const service = new OrchestratorTaskService(
      makeRuntime(makeFakeAcp()) as never,
      { store },
    );

    const result = await service.sweepOrphanedValidations();

    expect(result).toMatchObject({ reArmed: 0, resolved: 1 });
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("waiting_on_user");
    const orphanEvent = doc?.events.find(
      (e) => e.eventType === "verify_restart_orphaned",
    );
    expect(orphanEvent?.summary).toContain("did not survive a restart");
    expect(doc?.task.metadata?.verifyParkedAt).toBeTruthy();
  });

  it("no-ops on a second sweep once the task is resolved (idempotent)", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskId = await makeValidatingTask(store);
    await addSession(store, taskId, "sess-1");
    await addCompletionEvent(store, taskId, "sess-1", "Built and verified.");
    const service = new OrchestratorTaskService(
      makeRuntime(makeFakeAcp()) as never,
      { store },
    );

    await service.sweepOrphanedValidations();
    expect((await store.getTask(taskId))?.task.status).toBe("done");
    const eventCountAfterFirst = (await store.getTask(taskId))?.events.length;

    const second = await service.sweepOrphanedValidations();

    expect(second).toEqual({ reArmed: 0, resolved: 0, skipped: 0 });
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("done");
    expect(doc?.events.length).toBe(eventCountAfterFirst);
  });

  it("re-arms only the verdict-less lane of a multi-lane task and closes it when the last verdict lands", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskId = await makeValidatingTask(store, {
      metadata: { laneVerdicts: { "lane-a": "passed" } },
    });
    await addSession(store, taskId, "lane-a", {
      metadata: { requestVoicePart: "part:0" },
    });
    await addSession(store, taskId, "lane-b", {
      metadata: { requestVoicePart: "part:1" },
    });
    await addCompletionEvent(store, taskId, "lane-a", "Lane A done.");
    await addCompletionEvent(store, taskId, "lane-b", "Lane B done.");
    const service = new OrchestratorTaskService(
      makeRuntime(makeFakeAcp()) as never,
      { store },
    );

    const result = await service.sweepOrphanedValidations();

    // Lane A already has its verdict — only lane B re-arms.
    expect(result).toMatchObject({ reArmed: 1, resolved: 0, skipped: 1 });
    const doc = await store.getTask(taskId);
    const rearmed = (doc?.events ?? []).filter(
      (e) => e.eventType === "verify_restart_rearmed",
    );
    expect(rearmed.map((e) => e.sessionId)).toEqual(["lane-b"]);
    expect(doc?.task.metadata?.laneVerdicts).toEqual({
      "lane-a": "passed",
      "lane-b": "passed",
    });
    expect(doc?.task.status).toBe("done");
  });

  it("promotes without duplicating an already-delivered completion relay", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const released: string[] = [];
    const router = {
      releaseDeferredCompletionRelay: (
        _taskId: string,
        verdict: string,
        sessionId?: string,
      ) => released.push(`${verdict}:${sessionId}`),
    };
    const taskId = await makeValidatingTask(store, {
      // The relay for this completion was ALREADY delivered (the router's
      // restart sweep posted it with the honest restart note); only the
      // status needs resolving — the live a7136dab shape.
      metadata: {
        deliveredCompletionRelayKeys: ["req-key-1"],
      },
    });
    await addSession(store, taskId, "sess-1");
    await addCompletionEvent(store, taskId, "sess-1", "Deployed and done.");
    const acp = makeFakeAcp();
    const runtime = makeRuntime(acp, { router }) as never as Record<
      string,
      unknown
    >;
    const service = new OrchestratorTaskService(runtime as never, { store });

    const result = await service.sweepOrphanedValidations();

    expect(result).toMatchObject({ reArmed: 1, resolved: 0 });
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("done");
    // The verdict releases through the router's in-memory deferral API (a
    // no-op after a restart) — the sweep itself never posts a relay and the
    // durable ledger is untouched: delivered keys unchanged, nothing pending.
    expect(released).toEqual(["passed:sess-1"]);
    expect(doc?.task.metadata?.deliveredCompletionRelayKeys).toEqual([
      "req-key-1",
    ]);
    expect(doc?.task.metadata?.pendingCompletionRelays).toBeUndefined();
  });

  it("leaves a validating task alone while its lane's ACP session is still live", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const taskId = await makeValidatingTask(store);
    await addSession(store, taskId, "sess-live");
    await addCompletionEvent(store, taskId, "sess-live", "Done.");
    const acp = makeFakeAcp(
      new Map([
        [
          "sess-live",
          { id: "sess-live", status: "busy", agentType: "elizaos" },
        ],
      ]),
    );
    const service = new OrchestratorTaskService(makeRuntime(acp) as never, {
      store,
    });

    const result = await service.sweepOrphanedValidations();

    expect(result).toEqual({ reArmed: 0, resolved: 0, skipped: 1 });
    expect((await store.getTask(taskId))?.task.status).toBe("validating");
  });

  describe("auto-verify disabled", () => {
    const prev = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    afterEach(() => {
      if (prev === undefined)
        delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
      else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = prev;
    });

    it("does not touch validating tasks when auto-verify is operator-disabled", async () => {
      process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
      const store = new OrchestratorTaskStore({ backend: "memory" });
      const taskId = await makeValidatingTask(store);
      await addSession(store, taskId, "sess-1");
      await addCompletionEvent(store, taskId, "sess-1", "Done.");
      const service = new OrchestratorTaskService(
        makeRuntime(makeFakeAcp()) as never,
        { store },
      );

      const result = await service.sweepOrphanedValidations();

      // `validating` legitimately awaits a manual /validate in this config.
      expect(result).toEqual({ reArmed: 0, resolved: 0, skipped: 0 });
      expect((await store.getTask(taskId))?.task.status).toBe("validating");
    });
  });
});
