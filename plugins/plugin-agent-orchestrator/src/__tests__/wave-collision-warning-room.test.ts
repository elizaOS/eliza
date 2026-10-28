/**
 * Wave collision warnings through a PGlite-backed AgentRuntime with the
 * production task service and wave supervisor. Every lane plan numbers its
 * lanes lane-1, lane-2, ..., so two waves from two conversations share lane
 * ids; each wave's warning must still reach the room that started that wave.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  IAgentRuntime,
  Memory,
  ServiceClass,
  UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
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

const WAVE_INTERVAL_SETTING = "ELIZA_ORCHESTRATOR_WAVE_INTERVAL_MS";
const SOURCE = "wave-test-chat";

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

describe("wave collision warning room", () => {
  let runtime: AgentRuntime;
  let cleanupRuntime: (() => Promise<void>) | undefined;
  let service: OrchestratorTaskService;
  let supervisor: WaveSupervisor;
  const delivered: Array<{ roomId: string | undefined; text: string }> = [];
  const previous = {
    supervisor: process.env[WAVE_SUPERVISOR_SETTING],
    interval: process.env[WAVE_INTERVAL_SETTING],
  };

  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  /** A running lane task as TASKS create stamps it from a lane plan. */
  const startLane = async (
    roomId: UUID,
    waveId: string,
    laneId: string,
    scope: string,
  ) => {
    const lane = await service.createTask({
      title: `Lane ${laneId}`,
      goal: `Work on ${scope}`,
      acceptanceCriteria: [],
      roomId,
      metadata: {
        source: SOURCE,
        waveId,
        lane: {
          id: laneId,
          title: `Lane ${laneId}`,
          branchName: `wave/${laneId}`,
          dependencies: [],
          scopePaths: [scope],
          forbiddenPaths: [],
          collisions: [],
          difficultyTag: "medium",
        },
      },
    });
    await service.spawnAgentForTask(lane.id, { task: `Work on ${scope}` });
    expect((await service.getTask(lane.id))?.status).toBe("active");
    return lane;
  };

  beforeAll(async () => {
    process.env[WAVE_SUPERVISOR_SETTING] = "1";
    // Keep the supervisor timer out of the test; runOnce is called directly.
    process.env[WAVE_INTERVAL_SETTING] = "3600000";
    ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
      characterName: "OrchestratorWaveCollisionTest",
      plugins: [
        {
          name: "orchestrator-wave-collision-test",
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
    const loadedService = await runtime.getServiceLoadPromise(
      OrchestratorTaskService.serviceType,
    );
    const loadedSupervisor = await runtime.getServiceLoadPromise(
      WaveSupervisor.serviceType,
    );
    if (
      !(loadedService instanceof OrchestratorTaskService) ||
      !(loadedSupervisor instanceof WaveSupervisor) ||
      !loadedSupervisor.enabled()
    ) {
      throw new Error("Production orchestrator services did not start");
    }
    service = loadedService;
    supervisor = loadedSupervisor;
    runtime.registerSendHandler(SOURCE, async (_runtime, target, content) => {
      delivered.push({ roomId: target.roomId, text: content.text ?? "" });
      return {
        id: randomUUID() as UUID,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: target.roomId as UUID,
        content,
        createdAt: Date.now(),
      } satisfies Memory;
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupRuntime?.();
    restoreEnv(WAVE_SUPERVISOR_SETTING, previous.supervisor);
    restoreEnv(WAVE_INTERVAL_SETTING, previous.interval);
  });

  it("posts each wave's collision warning to the room that started that wave", async () => {
    // Two conversations each start a wave whose lane-1 and lane-2 scopes
    // overlap. Both plans use the same lane ids.
    const firstRoom = randomUUID() as UUID;
    const secondRoom = randomUUID() as UUID;
    const firstWave = randomUUID();
    const secondWave = randomUUID();
    await startLane(firstRoom, firstWave, "lane-1", "src/parser");
    await startLane(firstRoom, firstWave, "lane-2", "src/parser/tokenize.ts");
    await startLane(secondRoom, secondWave, "lane-1", "docs/api");
    await startLane(secondRoom, secondWave, "lane-2", "docs/api/routes.md");

    await supervisor.runOnce();

    const warnings = delivered.filter((message) =>
      message.text.includes("collision warning"),
    );
    expect(warnings).toHaveLength(2);
    const firstWarnings = warnings.filter((message) =>
      message.text.includes(`Wave ${firstWave}`),
    );
    const secondWarnings = warnings.filter((message) =>
      message.text.includes(`Wave ${secondWave}`),
    );
    expect(firstWarnings).toHaveLength(1);
    expect(secondWarnings).toHaveLength(1);
    expect(firstWarnings[0]?.text).toContain("on src/parser.");
    expect(secondWarnings[0]?.text).toContain("on docs/api.");
    expect(firstWarnings[0]?.roomId).toBe(firstRoom);
    expect(secondWarnings[0]?.roomId).toBe(secondRoom);
  });
});
