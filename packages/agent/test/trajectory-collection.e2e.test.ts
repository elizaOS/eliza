import http from "node:http";
import type { AgentRuntime, Memory, MessagePayload } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";
import trajectoryLoggerPlugin from "@elizaos/plugin-trajectory-logger";
import { describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

type TrajectoryStatus = "active" | "completed" | "error" | "timeout";

type StoredLlmCall = {
  callId: string;
  timestamp: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
};

type StoredStep = {
  stepId: string;
  stepNumber: number;
  timestamp: number;
  llmCalls: StoredLlmCall[];
  providerAccesses: Array<{
    providerId: string;
    providerName: string;
    timestamp: number;
    data: Record<string, unknown>;
    purpose: string;
  }>;
};

type StoredTrajectory = {
  id: string;
  agentId: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  createdAt: string;
  steps: StoredStep[];
  metadata: Record<string, unknown>;
};

interface RawSqlQuery {
  queryChunks?: Array<{
    value?: string[];
  }>;
}

function sqlText(query: RawSqlQuery): string {
  const chunks = query.queryChunks ?? [];
  return chunks
    .map((chunk) => (Array.isArray(chunk.value) ? chunk.value.join("") : ""))
    .join("")
    .trim();
}

function parseLimitOffset(query: string): { limit: number; offset: number } {
  const limitMatch = /limit\s+(\d+)/i.exec(query);
  const offsetMatch = /offset\s+(\d+)/i.exec(query);
  return {
    limit: limitMatch ? Number(limitMatch[1]) : 50,
    offset: offsetMatch ? Number(offsetMatch[1]) : 0,
  };
}

function unescapeSqlLiteral(value: string): string {
  return value.replace(/''/g, "'");
}

class InMemoryTrajectoryStore {
  private counter = 0;
  private readonly activeByStepId = new Map<string, StoredTrajectory>();
  private readonly persistedById = new Map<string, StoredTrajectory>();

  start(
    stepId: string,
    options: {
      agentId: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): string {
    this.counter += 1;
    const id = `trajectory-${this.counter}`;
    const now = Date.now();
    const trajectory: StoredTrajectory = {
      id,
      agentId: options.agentId,
      source: options.source ?? "chat",
      status: "active",
      startTime: now,
      endTime: null,
      durationMs: null,
      createdAt: new Date(now).toISOString(),
      steps: [
        {
          stepId,
          stepNumber: 0,
          timestamp: now,
          llmCalls: [],
          providerAccesses: [],
        },
      ],
      metadata: {
        roomId: options.roomId,
        entityId: options.entityId,
        ...(options.metadata ?? {}),
      },
    };
    this.activeByStepId.set(stepId, trajectory);
    return id;
  }

  logLlmCall(params: {
    stepId: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    temperature: number;
    maxTokens: number;
    purpose: string;
    actionType?: string;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
  }): void {
    const trajectory = this.activeByStepId.get(params.stepId);
    if (!trajectory) return;
    const step = trajectory.steps[0];
    step.llmCalls.push({
      callId: `call-${trajectory.id}-${step.llmCalls.length + 1}`,
      timestamp: Date.now(),
      model: params.model,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      response: params.response,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      purpose: params.purpose,
      actionType: params.actionType,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      latencyMs: params.latencyMs,
    });
  }

  end(stepIdOrTrajectoryId: string, status: TrajectoryStatus): void {
    let stepId = stepIdOrTrajectoryId;
    let trajectory = this.activeByStepId.get(stepId);
    if (!trajectory) {
      for (const [
        candidateStepId,
        candidateTrajectory,
      ] of this.activeByStepId.entries()) {
        if (candidateTrajectory.id === stepIdOrTrajectoryId) {
          trajectory = candidateTrajectory;
          stepId = candidateStepId;
          break;
        }
      }
    }
    if (!trajectory) return;

    const now = Date.now();
    trajectory.status = status;
    trajectory.endTime = now;
    trajectory.durationMs = Math.max(0, now - trajectory.startTime);

    this.activeByStepId.delete(stepId);
    for (const [candidateStepId, candidateTrajectory] of this.activeByStepId) {
      if (candidateTrajectory.id === trajectory.id) {
        this.activeByStepId.delete(candidateStepId);
      }
    }
    this.persistedById.set(trajectory.id, trajectory);
  }

  bindStepToTrajectory(trajectoryId: string, stepId: string): boolean {
    for (const trajectory of this.activeByStepId.values()) {
      if (trajectory.id === trajectoryId) {
        this.activeByStepId.set(stepId, trajectory);
        return true;
      }
    }
    return false;
  }

  listPersisted(): StoredTrajectory[] {
    return Array.from(this.persistedById.values()).sort(
      (a, b) => b.startTime - a.startTime,
    );
  }

  getPersisted(trajectoryId: string): StoredTrajectory | null {
    return this.persistedById.get(trajectoryId) ?? null;
  }

  toSqlRows(): Array<Record<string, unknown>> {
    return this.listPersisted().map((trajectory) => {
      const llmCallCount = trajectory.steps.reduce(
        (sum, step) => sum + step.llmCalls.length,
        0,
      );
      const totalPromptTokens = trajectory.steps.reduce(
        (sum, step) =>
          sum +
          step.llmCalls.reduce(
            (callSum, call) => callSum + (call.promptTokens ?? 0),
            0,
          ),
        0,
      );
      const totalCompletionTokens = trajectory.steps.reduce(
        (sum, step) =>
          sum +
          step.llmCalls.reduce(
            (callSum, call) => callSum + (call.completionTokens ?? 0),
            0,
          ),
        0,
      );
      return {
        id: trajectory.id,
        agent_id: trajectory.agentId,
        source: trajectory.source,
        status: trajectory.status,
        start_time: trajectory.startTime,
        end_time: trajectory.endTime,
        duration_ms: trajectory.durationMs,
        step_count: trajectory.steps.length,
        llm_call_count: llmCallCount,
        provider_access_count: 0,
        total_prompt_tokens: totalPromptTokens,
        total_completion_tokens: totalCompletionTokens,
        total_reward: 0,
        created_at: trajectory.createdAt,
        steps_json: JSON.stringify(trajectory.steps),
      };
    });
  }
}

class FakeTrajectoryLoggerService {
  private enabled = true;

  constructor(private readonly store: InMemoryTrajectoryStore) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async startTrajectory(
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentId =
      isLegacySignature && options?.agentId ? options.agentId : stepIdOrAgentId;

    return this.store.start(stepId, {
      agentId,
      roomId: options?.roomId,
      entityId: options?.entityId,
      source: options?.source,
      metadata: options?.metadata,
    });
  }

  startStep(trajectoryId: string): string {
    const stepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!this.store.bindStepToTrajectory(trajectoryId, stepId)) {
      return trajectoryId;
    }
    return stepId;
  }

  async endTrajectory(
    stepIdOrTrajectoryId: string,
    status = "completed",
  ): Promise<void> {
    this.store.end(stepIdOrTrajectoryId, status as TrajectoryStatus);
  }

  logLlmCall(params: {
    stepId: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    temperature: number;
    maxTokens: number;
    purpose: string;
    actionType?: string;
    promptTokens?: number;
    completionTokens?: number;
    latencyMs?: number;
  }): void {
    this.store.logLlmCall(params);
  }

  async listTrajectories(options: {
    limit?: number;
    offset?: number;
    status?: "active" | "completed" | "error" | "timeout";
    source?: string;
  }): Promise<{
    trajectories: Array<{
      id: string;
      agentId: string;
      source: string;
      status: "active" | "completed" | "error" | "timeout";
      startTime: number;
      endTime: number | null;
      durationMs: number | null;
      stepCount: number;
      llmCallCount: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      totalReward: number;
      scenarioId: string | null;
      batchId: string | null;
      createdAt: string;
    }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const limit = Math.max(1, Math.min(500, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);
    let all = this.store.listPersisted();
    if (options.status)
      all = all.filter((item) => item.status === options.status);
    if (options.source)
      all = all.filter((item) => item.source === options.source);
    const paged = all.slice(offset, offset + limit);

    return {
      trajectories: paged.map((trajectory) => {
        const llmCallCount = trajectory.steps.reduce(
          (sum, step) => sum + step.llmCalls.length,
          0,
        );
        const totalPromptTokens = trajectory.steps.reduce(
          (sum, step) =>
            sum +
            step.llmCalls.reduce(
              (callSum, call) => callSum + (call.promptTokens ?? 0),
              0,
            ),
          0,
        );
        const totalCompletionTokens = trajectory.steps.reduce(
          (sum, step) =>
            sum +
            step.llmCalls.reduce(
              (callSum, call) => callSum + (call.completionTokens ?? 0),
              0,
            ),
          0,
        );
        return {
          id: trajectory.id,
          agentId: trajectory.agentId,
          source: trajectory.source,
          status: trajectory.status,
          startTime: trajectory.startTime,
          endTime: trajectory.endTime,
          durationMs: trajectory.durationMs,
          stepCount: trajectory.steps.length,
          llmCallCount,
          totalPromptTokens,
          totalCompletionTokens,
          totalReward: 0,
          scenarioId: null,
          batchId: null,
          createdAt: trajectory.createdAt,
        };
      }),
      total: all.length,
      offset,
      limit,
    };
  }

  async getTrajectoryDetail(trajectoryId: string): Promise<{
    trajectoryId: string;
    agentId: string;
    startTime: number;
    endTime: number;
    durationMs: number;
    steps: StoredStep[];
    totalReward: number;
    metrics: {
      episodeLength: number;
      finalStatus: "completed" | "terminated" | "error" | "timeout";
    };
    metadata: Record<string, unknown>;
  } | null> {
    const trajectory = this.store.getPersisted(trajectoryId);
    if (
      !trajectory ||
      trajectory.endTime == null ||
      trajectory.durationMs == null
    ) {
      return null;
    }
    const status =
      trajectory.status === "active" ? "completed" : trajectory.status;
    return {
      trajectoryId: trajectory.id,
      agentId: trajectory.agentId,
      startTime: trajectory.startTime,
      endTime: trajectory.endTime,
      durationMs: trajectory.durationMs,
      steps: trajectory.steps,
      totalReward: 0,
      metrics: {
        episodeLength: trajectory.steps.length,
        finalStatus:
          status === "completed" || status === "error" || status === "timeout"
            ? status
            : "terminated",
      },
      metadata: trajectory.metadata,
    };
  }

  async getStats(): Promise<{
    totalTrajectories: number;
    totalSteps: number;
    totalLlmCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    averageDurationMs: number;
    averageReward: number;
    bySource: Record<string, number>;
    byStatus: Record<string, number>;
    byScenario: Record<string, number>;
  }> {
    const trajectories = this.store.listPersisted();
    const totalSteps = trajectories.reduce(
      (sum, item) => sum + item.steps.length,
      0,
    );
    const totalLlmCalls = trajectories.reduce(
      (sum, item) =>
        sum +
        item.steps.reduce((stepSum, step) => stepSum + step.llmCalls.length, 0),
      0,
    );
    const totalPromptTokens = trajectories.reduce(
      (sum, item) =>
        sum +
        item.steps.reduce(
          (stepSum, step) =>
            stepSum +
            step.llmCalls.reduce(
              (callSum, call) => callSum + (call.promptTokens ?? 0),
              0,
            ),
          0,
        ),
      0,
    );
    const totalCompletionTokens = trajectories.reduce(
      (sum, item) =>
        sum +
        item.steps.reduce(
          (stepSum, step) =>
            stepSum +
            step.llmCalls.reduce(
              (callSum, call) => callSum + (call.completionTokens ?? 0),
              0,
            ),
          0,
        ),
      0,
    );

    return {
      totalTrajectories: trajectories.length,
      totalSteps,
      totalLlmCalls,
      totalPromptTokens,
      totalCompletionTokens,
      averageDurationMs:
        trajectories.length === 0
          ? 0
          : trajectories.reduce(
              (sum, item) => sum + (item.durationMs ?? 0),
              0,
            ) / trajectories.length,
      averageReward: 0,
      bySource: trajectories.reduce(
        (acc, item) => {
          acc[item.source] = (acc[item.source] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
      byStatus: trajectories.reduce(
        (acc, item) => {
          acc[item.status] = (acc[item.status] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
      byScenario: {},
    };
  }

  async deleteTrajectories(trajectoryIds: string[]): Promise<number> {
    let deleted = 0;
    for (const id of trajectoryIds) {
      if (this.store.getPersisted(id)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async clearAllTrajectories(): Promise<number> {
    const count = this.store.listPersisted().length;
    return count;
  }

  async exportTrajectories(): Promise<{
    data: string;
    filename: string;
    mimeType: string;
  }> {
    return {
      data: "[]",
      filename: "trajectories.json",
      mimeType: "application/json",
    };
  }
}

class FakeSqlDb {
  constructor(private readonly store: InMemoryTrajectoryStore) {}

  async execute(
    query: RawSqlQuery,
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    const sql = sqlText(query);
    const normalized = sql.toLowerCase().replace(/\s+/g, " ");

    if (normalized.includes("to_regclass('public.trajectories')")) {
      return { rows: [{ table_name: "trajectories" }] };
    }

    if (
      normalized.startsWith("select count(*)::int as total from trajectories")
    ) {
      return { rows: [{ total: this.store.toSqlRows().length }] };
    }

    if (
      normalized.startsWith("select * from trajectories") &&
      normalized.includes("order by")
    ) {
      const { limit, offset } = parseLimitOffset(sql);
      return {
        rows: this.store.toSqlRows().slice(offset, offset + limit),
      };
    }

    if (
      normalized.startsWith("select * from trajectories") &&
      normalized.includes("where")
    ) {
      const idMatch = /\bid\s*=\s*'((?:''|[^'])+)'/i.exec(sql);
      const id = idMatch ? unescapeSqlLiteral(idMatch[1]) : "";
      const row = this.store
        .toSqlRows()
        .find((candidate) => candidate.id === id);
      return { rows: row ? [row] : [] };
    }

    return { rows: [] };
  }
}

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: response.statusCode ?? 0, data });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

describe("trajectory collection bridge e2e", () => {
  it("collects trajectories and exposes them in both trajectories and fine-tuning APIs", async () => {
    const store = new InMemoryTrajectoryStore();
    const trajectoryLogger = new FakeTrajectoryLoggerService(store);
    const db = new FakeSqlDb(store);

    const runtimeSubset = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "TrajectoryBridgeE2E" },
      adapter: { db },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      getService: (serviceType: string) => {
        if (serviceType === "trajectory_logger") {
          return trajectoryLogger;
        }
        return null;
      },
      getServicesByType: (serviceType: string) => {
        if (serviceType === "trajectory_logger") {
          return [trajectoryLogger];
        }
        return [];
      },
      getRoom: async (roomId: string) => ({
        id: roomId,
        source: "chat",
        type: "DM",
        channelId: roomId,
      }),
      getRoomsByWorld: async () => [],
      getMemories: async () => [],
      getCache: async () => null,
      setCache: async () => {},
    };
    const runtime = runtimeSubset as unknown as AgentRuntime;

    const plugin = trajectoryLoggerPlugin;
    const onMessageReceived = plugin.events?.MESSAGE_RECEIVED?.[0];
    const onMessageSent = plugin.events?.MESSAGE_SENT?.[0];
    expect(onMessageReceived).toBeTypeOf("function");
    expect(onMessageSent).toBeTypeOf("function");

    const incoming = {
      id: "incoming-message-1",
      roomId: "room-1",
      entityId: "entity-1",
      content: {
        text: "hello",
        source: "chat",
      },
      metadata: {
        type: "message",
      },
    } as unknown as Memory;

    await onMessageReceived?.({
      runtime,
      source: "chat",
      message: incoming,
    } as MessagePayload);

    const metadata = incoming.metadata as Record<string, unknown>;
    const stepId = metadata.trajectoryStepId;
    expect(typeof stepId).toBe("string");

    trajectoryLogger.logLlmCall({
      stepId: String(stepId),
      model: "test-model",
      systemPrompt: "You are helpful.",
      userPrompt: "hello from user",
      response: "hi there",
      temperature: 0,
      maxTokens: 64,
      purpose: "action",
      actionType: "runtime.useModel",
      promptTokens: 12,
      completionTokens: 4,
      latencyMs: 9,
    });

    const outgoing = {
      id: "outgoing-message-1",
      roomId: "room-1",
      entityId: "entity-agent",
      content: {
        text: "hi there",
        inReplyTo: createUniqueUuid(runtime, incoming.id),
      },
      metadata: {
        type: "message",
      },
    } as unknown as Memory;

    await onMessageSent?.({
      runtime,
      source: "chat",
      message: outgoing,
    } as MessagePayload);

    const server = await startApiServer({ port: 0, runtime });
    try {
      const trajectories = await req(server.port, "GET", "/api/trajectories");
      expect(trajectories.status).toBe(200);
      const trajectoryRows = trajectories.data.trajectories as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(trajectoryRows)).toBe(true);
      expect(trajectoryRows.length).toBeGreaterThan(0);
      const firstTrajectory = trajectoryRows[0];
      expect(firstTrajectory.llmCallCount).toBe(1);

      const training = await req(
        server.port,
        "GET",
        "/api/training/trajectories?limit=20&offset=0",
      );
      expect(training.status).toBe(200);
      // Training service may not be available in CI (plugin-training submodule)
      if (training.data.available) {
        const trainingRows = training.data.trajectories as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(trainingRows)).toBe(true);
        expect(trainingRows.length).toBeGreaterThan(0);
        expect(trainingRows[0].llmCallCount).toBe(1);
        expect(trainingRows[0].hasLlmCalls).toBe(true);
        expect(trainingRows[0].trajectoryId).toBe(firstTrajectory.id);

        const detail = await req(
          server.port,
          "GET",
          `/api/training/trajectories/${encodeURIComponent(String(firstTrajectory.id))}`,
        );
        expect(detail.status).toBe(200);
        const trajectory = detail.data.trajectory as Record<string, unknown>;
        expect(String(trajectory.stepsJson)).toContain("hi there");
      }
    } finally {
      await server.close();
    }
  });
});
