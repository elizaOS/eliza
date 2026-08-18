/**
 * Exercises the production TASKS → durable task store → Smithers recovery
 * chokepoint across fresh service/ACP instances and a file-backed task store.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTaskAction } from "../../src/actions/tasks.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  readSmithersDurableRunLink,
  type SmithersDurableRunLink,
  smithersDurableRunMetadata,
} from "../../src/services/smithers-task-integration.js";
import type {
  SessionEventName,
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../../src/services/types.js";
import {
  callback,
  memory,
  state,
} from "../../src/test-utils/action-test-utils.js";

const priorSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
const priorGoalContract = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
const priorAutoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;

beforeAll(() => {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "1";
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
});

afterAll(() => {
  if (priorSmithers === undefined)
    delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
  else process.env.ELIZA_ORCHESTRATOR_SMITHERS = priorSmithers;
  if (priorGoalContract === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = priorGoalContract;
  if (priorAutoVerify === undefined)
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = priorAutoVerify;
});

type SessionEventHandler = (
  sessionId: string,
  event: SessionEventName,
  data: unknown,
) => void;

interface PersistedAcpState {
  sessions: Map<string, SessionInfo>;
  prompts: string[];
  nextId: number;
}

class RestartableAcp {
  readonly emitsPromptTerminalEvents = true;
  private readonly handlers = new Set<SessionEventHandler>();
  private readonly liveSessions = new Set<string>();

  constructor(
    private readonly persisted: PersistedAcpState,
    private readonly suppressPromptTerminalEvent = false,
  ) {}

  async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const id = `restart-session-${++this.persisted.nextId}`;
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: id,
      agentType: opts.agentType ?? "codex",
      workdir: opts.workdir ?? tmpdir(),
      status: "ready",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: { ...(opts.metadata ?? {}) },
    };
    this.persisted.sessions.set(id, session);
    this.liveSessions.add(id);
    this.emitSessionEvent(id, "ready", { sessionId: id });
    return this.spawnResult(session);
  }

  async sendPrompt(sessionId: string, text: string) {
    this.persisted.prompts.push(text);
    const session = this.persisted.sessions.get(sessionId);
    if (!session) throw new Error(`missing fake ACP session ${sessionId}`);
    session.status = "ready";
    session.lastActivityAt = new Date();
    const result = {
      sessionId,
      response: "restart-safe result",
      finalText: "restart-safe result",
      stopReason: "end_turn",
      durationMs: 1,
    };
    if (!this.suppressPromptTerminalEvent) {
      this.emitSessionEvent(sessionId, "task_complete", {
        response: result.finalText,
        stopReason: result.stopReason,
      });
    }
    return result;
  }

  sendToSession(sessionId: string, text: string) {
    return this.sendPrompt(sessionId, text);
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.persisted.sessions.get(sessionId);
    if (!session) return;
    session.status = "stopped";
    session.lastActivityAt = new Date();
    this.liveSessions.delete(sessionId);
    this.emitSessionEvent(sessionId, "stopped", { sessionId });
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.persisted.sessions.get(sessionId);
    if (session) session.status = "cancelled";
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.persisted.sessions.values()];
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    return this.persisted.sessions.get(sessionId);
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const session = this.persisted.sessions.get(sessionId);
    if (!session) throw new Error(`missing fake ACP session ${sessionId}`);
    session.metadata = { ...(session.metadata ?? {}), ...patch };
  }

  async prepareSessionForDurableRecovery(
    sessionId: string,
  ): Promise<SpawnResult> {
    const prior = this.persisted.sessions.get(sessionId);
    if (!prior) throw new Error(`missing fake ACP session ${sessionId}`);
    if (this.liveSessions.has(sessionId)) return this.spawnResult(prior);
    const replacement = await this.spawnSession({
      agentType: prior.agentType,
      workdir: prior.workdir,
      approvalPreset: prior.approvalPreset,
      metadata: { ...(prior.metadata ?? {}), reattachedFrom: prior.id },
    });
    prior.status = "stopped";
    return replacement;
  }

  onSessionEvent(handler: SessionEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emitSessionEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): void {
    for (const handler of this.handlers) handler(sessionId, event, data);
  }

  async resolveAgentType(): Promise<string> {
    return "codex";
  }

  private spawnResult(session: SessionInfo): SpawnResult {
    return {
      sessionId: session.id,
      id: session.id,
      name: session.name ?? session.id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
    };
  }
}

function runtimeFor(acp: RestartableAcp, taskService: unknown): IAgentRuntime {
  return {
    agentId: "restart-tenant",
    getService: vi.fn((serviceType: string) =>
      serviceType === "ORCHESTRATOR_TASK_SERVICE" ? taskService : acp,
    ),
    hasService: vi.fn(() => true),
    getRoom: vi.fn(async () => ({ id: "room1" })),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    reportError: vi.fn(),
    getSetting: vi.fn(() => undefined),
  } as never;
}

describe("TASKS Smithers restart recovery", () => {
  async function createLiveLinkedTask(input: {
    dir: string;
    stateFile: string;
    acp: RestartableAcp;
  }): Promise<{
    service: OrchestratorTaskService;
    store: OrchestratorTaskStore;
    runtime: IAgentRuntime;
    taskId: string;
    sessionId: string;
    link: SmithersDurableRunLink;
  }> {
    const store = new OrchestratorTaskStore({ stateFile: input.stateFile });
    const runtime = runtimeFor(input.acp, null);
    const service = new OrchestratorTaskService(runtime, { store });
    runtime.getService = vi.fn((serviceType: string) =>
      serviceType === "ORCHESTRATOR_TASK_SERVICE" ? service : input.acp,
    ) as never;
    await service.start();
    const created = await service.createTask({
      title: "Terminal Smithers task",
      goal: "Commit one terminal result",
      acceptanceCriteria: [],
      roomId: "11111111-1111-4111-8111-111111111111",
    });
    const link: SmithersDurableRunLink = {
      version: 1,
      orchestratorTaskId: created.id,
      tenantId: "restart-tenant",
      taskId: "smithers-task-terminal",
      runId: "smithers-run-terminal",
      initialPrompt: "commit one terminal result",
      state: "running",
      keepAliveAfterComplete: true,
    };
    const spawned = await input.acp.spawnSession({
      agentType: "codex",
      workdir: input.dir,
      metadata: {
        taskId: created.id,
        ...smithersDurableRunMetadata(link),
      },
    });
    await service.attachSession(created.id, {
      sessionId: spawned.sessionId,
      agentType: spawned.agentType,
      workdir: spawned.workdir,
      status: "ready",
      metadata: spawned.metadata,
      durableRun: link,
    });
    return {
      service,
      store,
      runtime,
      taskId: created.id,
      sessionId: spawned.sessionId,
      link,
    };
  }

  it("persists linkage before the prompt and recovers a committed run without replaying it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-restart-"));
    let firstTaskService: OrchestratorTaskService | undefined;
    let restartedService: OrchestratorTaskService | undefined;
    try {
      const stateFile = join(dir, "orchestrator-tasks.json");
      const persistedAcp: PersistedAcpState = {
        sessions: new Map(),
        prompts: [],
        nextId: 0,
      };
      // Model a host termination after the durable Smithers graph commits but
      // before the ACP terminal event reaches this process. The explicit
      // completion-copy write below then fails on the task-store side, leaving
      // the task copy running for restart recovery.
      const firstAcp = new RestartableAcp(persistedAcp, true);
      const firstStore = new OrchestratorTaskStore({ stateFile });
      const firstRuntime = runtimeFor(firstAcp, null);
      firstTaskService = new OrchestratorTaskService(firstRuntime, {
        store: firstStore,
      });
      firstRuntime.getService = vi.fn((serviceType: string) =>
        serviceType === "ORCHESTRATOR_TASK_SERVICE"
          ? firstTaskService
          : firstAcp,
      ) as never;
      await firstTaskService.start();

      let simulatedCrash = false;
      const actionTaskService = {
        createTask: firstTaskService.createTask.bind(firstTaskService),
        attachSession: firstTaskService.attachSession.bind(firstTaskService),
        updateSmithersDurableRun: async (
          sessionId: string,
          link: SmithersDurableRunLink,
        ) => {
          if (link.state === "completed" && !simulatedCrash) {
            simulatedCrash = true;
            throw new Error(
              "simulated host termination after Smithers committed",
            );
          }
          return firstTaskService.updateSmithersDurableRun(sessionId, link);
        },
      };
      const actionRuntime = runtimeFor(firstAcp, actionTaskService);

      const firstResult = await createTaskAction.handler(
        actionRuntime,
        memory({ text: "implement restart-safe work" }),
        state,
        {
          parameters: {
            action: "create",
            title: "Restart-safe task",
            goal: "Return one durable result",
            task: "implement restart-safe work",
            agentType: "codex",
            workdir: dir,
            approvalPreset: "readonly",
            timeout_ms: 30_000,
          },
        },
        callback(),
      );
      expect(firstResult?.success).toBe(false);
      expect(simulatedCrash).toBe(true);
      expect(persistedAcp.prompts).toEqual([
        expect.stringContaining("implement restart-safe work"),
      ]);

      const taskId = (
        await firstTaskService.listTasks({ includeArchived: true })
      )[0]?.id;
      expect(taskId).toBeTypeOf("string");
      const beforeRestart = await firstStore.getTask(taskId as string);
      const running = beforeRestart?.sessions
        .map((session) => readSmithersDurableRunLink(session.metadata))
        .find((link) => link?.state === "running");
      expect(running?.orchestratorTaskId).toBe(taskId);
      expect(running?.approvalPreset).toBe("readonly");
      expect(beforeRestart?.sessions[0]?.sessionId).toBe(
        [...persistedAcp.sessions.keys()][0],
      );
      await firstTaskService.stop();

      // Fresh instances model process restart: task data is reloaded from
      // disk. Dropping the ACP record forces recovery to reconstruct a fresh
      // transport solely from the task-session copy, including readonly policy.
      persistedAcp.sessions.clear();
      const restartedAcp = new RestartableAcp(persistedAcp);
      const restartedStore = new OrchestratorTaskStore({ stateFile });
      const restartedRuntime = runtimeFor(restartedAcp, null);
      restartedService = new OrchestratorTaskService(restartedRuntime, {
        store: restartedStore,
      });
      restartedRuntime.getService = vi.fn((serviceType: string) =>
        serviceType === "ORCHESTRATOR_TASK_SERVICE"
          ? restartedService
          : restartedAcp,
      ) as never;
      await restartedService.start();
      const recovery = await restartedService.recoverInterruptedSmithersRuns(
        restartedAcp as never,
      );

      expect(recovery).toEqual({ recovered: 1, skipped: 0 });
      // Smithers reads the terminal graph/result from its durable DB. The new
      // ACP transport is attached, but the initial prompt is never sent again.
      expect(persistedAcp.prompts).toHaveLength(1);
      expect(persistedAcp.sessions.size).toBe(1);
      expect([...persistedAcp.sessions.values()][0]?.approvalPreset).toBe(
        "readonly",
      );

      const afterRestart = await restartedStore.getTask(taskId as string);
      const links = afterRestart?.sessions
        .map((session) => readSmithersDurableRunLink(session.metadata))
        .filter((link): link is SmithersDurableRunLink => link !== undefined);
      expect(links?.some((link) => link.state === "completed")).toBe(true);
      expect(links?.some((link) => link.state === "superseded")).toBe(true);
    } finally {
      await restartedService?.stop();
      await firstTaskService?.stop();
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }, 60_000);

  it("drains task_complete until both durable Smithers copies are terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasks-smithers-terminal-drain-"));
    let service: OrchestratorTaskService | undefined;
    try {
      const persistedAcp: PersistedAcpState = {
        sessions: new Map(),
        prompts: [],
        nextId: 0,
      };
      const acp = new RestartableAcp(persistedAcp);
      const fixture = await createLiveLinkedTask({
        dir,
        stateFile: join(dir, "orchestrator-tasks.json"),
        acp,
      });
      service = fixture.service;

      let releaseWrite: (() => void) | undefined;
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let markWriteStarted: (() => void) | undefined;
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve;
      });
      const originalUpdate = acp.updateSessionMetadata.bind(acp);
      vi.spyOn(acp, "updateSessionMetadata").mockImplementation(
        async (sessionId, patch) => {
          markWriteStarted?.();
          await writeGate;
          await originalUpdate(sessionId, patch);
        },
      );

      acp.emitSessionEvent(fixture.sessionId, "task_complete", {
        response: "terminal result",
        stopReason: "end_turn",
      });
      await writeStarted;
      let stopped = false;
      const stopping = service.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      releaseWrite?.();
      await stopping;

      const acpLink = readSmithersDurableRunLink(
        persistedAcp.sessions.get(fixture.sessionId)?.metadata,
      );
      const taskLink = readSmithersDurableRunLink(
        (await fixture.store.getTask(fixture.taskId))?.sessions.find(
          (session) => session.sessionId === fixture.sessionId,
        )?.metadata,
      );
      expect(acpLink?.state).toBe("completed");
      expect(taskLink?.state).toBe("completed");
    } finally {
      await service?.stop();
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("does not replay a completed run when one terminal-copy write fails", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "tasks-smithers-partial-terminal-"),
    );
    let service: OrchestratorTaskService | undefined;
    try {
      const stateFile = join(dir, "orchestrator-tasks.json");
      const persistedAcp: PersistedAcpState = {
        sessions: new Map(),
        prompts: [],
        nextId: 0,
      };
      const acp = new RestartableAcp(persistedAcp);
      const fixture = await createLiveLinkedTask({ dir, stateFile, acp });
      service = fixture.service;
      vi.spyOn(acp, "updateSessionMetadata").mockRejectedValueOnce(
        new Error("simulated ACP metadata outage"),
      );

      acp.emitSessionEvent(fixture.sessionId, "task_complete", {
        response: "terminal result",
        stopReason: "end_turn",
      });
      await service.stop();
      service = undefined;

      expect(fixture.runtime.reportError).toHaveBeenCalledWith(
        "OrchestratorTask.recordSessionEvent",
        expect.any(Error),
        expect.objectContaining({
          sessionId: fixture.sessionId,
          event: "task_complete",
        }),
      );
      expect(
        readSmithersDurableRunLink(
          persistedAcp.sessions.get(fixture.sessionId)?.metadata,
        )?.state,
      ).toBe("running");
      expect(
        readSmithersDurableRunLink(
          (await fixture.store.getTask(fixture.taskId))?.sessions.find(
            (session) => session.sessionId === fixture.sessionId,
          )?.metadata,
        )?.state,
      ).toBe("completed");

      const restartedStore = new OrchestratorTaskStore({ stateFile });
      const restartedRuntime = runtimeFor(acp, null);
      const restartedService = new OrchestratorTaskService(restartedRuntime, {
        store: restartedStore,
      });
      restartedRuntime.getService = vi.fn((serviceType: string) =>
        serviceType === "ORCHESTRATOR_TASK_SERVICE" ? restartedService : acp,
      ) as never;
      const recovery = await restartedService.recoverInterruptedSmithersRuns(
        acp as never,
      );
      expect(recovery).toEqual({ recovered: 0, skipped: 0 });
      expect(persistedAcp.prompts).toEqual([]);
      await restartedService.stop();
    } finally {
      await service?.stop();
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
});
