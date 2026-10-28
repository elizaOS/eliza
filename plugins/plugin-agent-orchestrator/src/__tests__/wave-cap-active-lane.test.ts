/**
 * Wave concurrency cap for a lane that is already running, through a
 * PGlite-backed AgentRuntime with the production task service, wave supervisor
 * and parent-agent broker. The cap counts lanes: a running lane already holds
 * its slot, so a nested sub-agent it spawns must not be refused when the wave
 * is full, while a lane that has not started yet still waits.
 */

import type { AgentRuntime, IAgentRuntime, ServiceClass } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { runParentAgentBroker } from "../services/parent-agent-broker.js";
import type {
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../services/types.js";
import {
  WAVE_SUPERVISOR_SETTING,
  WaveSupervisor,
} from "../services/wave-supervisor.js";
import { createRealTestRuntime } from "./real-runtime.js";

const WAVE_CONCURRENCY_SETTING = "ELIZA_ORCHESTRATOR_WAVE_CONCURRENCY";

/** The production ACP service with the agent process left out: spawnSession
 *  records the session it would launch instead of starting a subprocess. */
class RecordingAcpService extends AcpService {
  static override async start(runtime: IAgentRuntime): Promise<AcpService> {
    return new RecordingAcpService(runtime);
  }

  readonly spawned = new Map<string, SessionInfo>();

  override async spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
    const id = `wave-session-${this.spawned.size + 1}`;
    const now = new Date();
    const session: SessionInfo = {
      id,
      name: opts.name ?? id,
      agentType: opts.agentType ?? "opencode",
      workdir: opts.workdir ?? "/tmp/wave-lane",
      status: "running",
      approvalPreset: opts.approvalPreset ?? "standard",
      createdAt: now,
      lastActivityAt: now,
      metadata: { ...(opts.metadata ?? {}) },
    };
    this.spawned.set(id, session);
    return {
      sessionId: id,
      id,
      name: session.name ?? id,
      agentType: session.agentType,
      workdir: session.workdir,
      status: session.status,
      metadata: session.metadata,
    };
  }

  override async getSession(
    sessionId: string,
  ): Promise<SessionInfo | undefined> {
    return this.spawned.get(sessionId);
  }
}

describe("wave cap for a lane that is already running", () => {
  let runtime: AgentRuntime;
  let cleanupRuntime: (() => Promise<void>) | undefined;
  let acp: RecordingAcpService;
  let service: OrchestratorTaskService;
  const waveId = "b3f1c7a2-4d5e-4f60-8a71-92b3c4d5e6f7";
  const previous = {
    supervisor: process.env[WAVE_SUPERVISOR_SETTING],
    concurrency: process.env[WAVE_CONCURRENCY_SETTING],
  };

  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  /** A lane task as TASKS create stamps it from a lane plan. */
  const createLane = (id: string, scope: string) =>
    service.createTask({
      title: `Lane ${id}`,
      goal: `Work on ${scope}`,
      acceptanceCriteria: [],
      metadata: {
        waveId,
        lane: {
          id,
          title: `Lane ${id}`,
          branchName: `wave/${id}`,
          dependencies: [],
          scopePaths: [scope],
          forbiddenPaths: [],
          collisions: [],
          difficultyTag: "medium",
        },
      },
    });

  const sessionsOf = async (taskId: string) =>
    (await service.getTask(taskId))?.sessions ?? [];

  beforeAll(async () => {
    process.env[WAVE_SUPERVISOR_SETTING] = "1";
    process.env[WAVE_CONCURRENCY_SETTING] = "2";
    ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
      characterName: "OrchestratorWaveCapTest",
      plugins: [
        {
          name: "orchestrator-wave-cap-test",
          description:
            "Registers the production task service and wave supervisor",
          services: [
            RecordingAcpService as unknown as ServiceClass,
            OrchestratorTaskService as unknown as ServiceClass,
            WaveSupervisor as unknown as ServiceClass,
          ],
        },
      ],
    }));
    const loadedAcp = await runtime.getServiceLoadPromise(
      AcpService.serviceType,
    );
    const loadedService = await runtime.getServiceLoadPromise(
      OrchestratorTaskService.serviceType,
    );
    const loadedSupervisor = await runtime.getServiceLoadPromise(
      WaveSupervisor.serviceType,
    );
    if (
      !(loadedAcp instanceof RecordingAcpService) ||
      !(loadedService instanceof OrchestratorTaskService) ||
      !(loadedSupervisor instanceof WaveSupervisor) ||
      !loadedSupervisor.enabled()
    ) {
      throw new Error("Production orchestrator services did not start");
    }
    acp = loadedAcp;
    service = loadedService;
  }, 60_000);

  afterAll(async () => {
    await cleanupRuntime?.();
    restoreEnv(WAVE_SUPERVISOR_SETTING, previous.supervisor);
    restoreEnv(WAVE_CONCURRENCY_SETTING, previous.concurrency);
  });

  it("lets a running lane spawn a nested sub-agent when its wave is full", async () => {
    const first = await createLane("lane-1", "src/parser");
    const second = await createLane("lane-2", "src/render");
    await service.spawnAgentForTask(first.id, { task: "Rewrite the parser" });
    await service.spawnAgentForTask(second.id, { task: "Fix the renderer" });
    expect((await service.getTask(first.id))?.status).toBe("active");
    expect((await service.getTask(second.id))?.status).toBe("active");

    const [coordinator] = await sessionsOf(first.id);
    const coordinatorSession = coordinator
      ? await acp.getSession(coordinator.sessionId)
      : undefined;
    expect(coordinatorSession?.metadata?.taskId).toBe(first.id);

    // The lane-1 coordinator asks the parent to run part of its work in
    // parallel: USE_SKILL parent-agent {"mode":"spawn-sub-agent",...}.
    const result = await runParentAgentBroker({
      runtime,
      sessionId: coordinatorSession?.id ?? "",
      session: coordinatorSession,
      args: {
        mode: "spawn-sub-agent",
        task: "Add unit tests for src/parser/tokenize.ts",
      },
    });

    expect(result.text).not.toContain("concurrency cap");
    expect(result.success).toBe(true);
    const laneSessions = await sessionsOf(first.id);
    expect(laneSessions).toHaveLength(2);
    expect(laneSessions[1]?.parentSessionId).toBe(coordinatorSession?.id);
    expect(acp.spawned.size).toBe(3);
  });

  it("still holds a lane that has not started while the wave is full", async () => {
    const third = await createLane("lane-3", "src/cli");
    const spawnedBefore = acp.spawned.size;

    await service.spawnAgentForTask(third.id, { task: "Add a CLI flag" });

    expect(acp.spawned.size).toBe(spawnedBefore);
    expect(await sessionsOf(third.id)).toHaveLength(0);
    expect((await service.getTask(third.id))?.status).not.toBe("active");
  });
});
