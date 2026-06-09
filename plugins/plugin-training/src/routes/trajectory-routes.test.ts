import type http from "node:http";
import { Readable } from "node:stream";
import type { Trajectory } from "@elizaos/agent";
import {
  type AgentRuntime,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleTrajectoryRoute } from "./trajectory-routes";

vi.mock("@elizaos/agent", () => ({
  createZipArchive: vi.fn(() => new Uint8Array()),
  enrichTrajectoryLlmCall: vi.fn((call) => call),
  executeRawSql: vi.fn(async () => []),
  extractRows: vi.fn(() => []),
  normalizePersistedTrajectoryTiming: vi.fn(
    (input: {
      status: string;
      startTime: number;
      endTime: number | null;
      durationMs?: number | null;
      createdAt?: unknown;
      updatedAt?: unknown;
    }) => {
      if (input.status === "active") {
        return { endTime: null, durationMs: null };
      }
      const parseTime = (value: unknown): number | null => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value !== "string") return null;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const startTime = Number.isFinite(input.startTime) ? input.startTime : 0;
      const endTime =
        (typeof input.endTime === "number" &&
        Number.isFinite(input.endTime) &&
        input.endTime > 0 &&
        input.endTime >= startTime
          ? input.endTime
          : null) ??
        parseTime(input.updatedAt) ??
        parseTime(input.createdAt) ??
        (startTime > 0 ? startTime : Date.now());
      return {
        endTime,
        durationMs:
          typeof input.durationMs === "number" &&
          Number.isFinite(input.durationMs) &&
          input.durationMs >= 0
            ? input.durationMs
            : Math.max(0, endTime - startTime),
      };
    },
  ),
  normalizePersistedUpdatedAt: vi.fn(
    (input: {
      startTime: number;
      endTime: number | null;
      createdAt?: unknown;
      updatedAt?: unknown;
    }) => {
      const parseTime = (value: unknown): number | null => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value !== "string") return null;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const startTime = Number.isFinite(input.startTime) ? input.startTime : 0;
      const endTime =
        typeof input.endTime === "number" && Number.isFinite(input.endTime)
          ? input.endTime
          : null;
      const floorTime = endTime ?? startTime;
      const updatedAt = parseTime(input.updatedAt);
      const createdAt = parseTime(input.createdAt);
      return new Date(
        (typeof updatedAt === "number" &&
        updatedAt > 0 &&
        updatedAt >= floorTime
          ? updatedAt
          : null) ??
          endTime ??
          createdAt ??
          (startTime > 0 ? startTime : Date.now()),
      ).toISOString();
    },
  ),
  saveTrajectory: vi.fn(async () => undefined),
}));

type MockResponse = http.ServerResponse & {
  body?: string | Uint8Array;
  headers: Record<string, string | number | readonly string[]>;
};

function createResponse(): MockResponse {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(body?: string | Uint8Array) {
      this.body = body;
      return this;
    },
  };
  return response as MockResponse;
}

function createRequest(body?: unknown): http.IncomingMessage {
  const request =
    body === undefined
      ? (Readable.from([]) as http.IncomingMessage)
      : (Readable.from([
          Buffer.from(JSON.stringify(body)),
        ]) as http.IncomingMessage);
  request.headers = {};
  request.url = "/";
  return request;
}

function createRuntime(logger: unknown): AgentRuntime {
  return {
    getServicesByType: () => [logger],
    getService: () => logger,
  } as unknown as AgentRuntime;
}

function createLogger(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isEnabled: vi.fn(() => true),
    setEnabled: vi.fn(),
    listTrajectories: vi.fn(),
    getTrajectoryDetail: vi.fn(),
    getStats: vi.fn(),
    deleteTrajectories: vi.fn(),
    clearAllTrajectories: vi.fn(),
    exportTrajectories: vi.fn(),
    ...overrides,
  };
}

function createTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    trajectoryId: "traj-1",
    agentId: "agent-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    durationMs: 1_000,
    steps: [],
    metrics: { finalStatus: "completed" },
    metadata: { source: "test" },
    ...overrides,
  };
}

function parseJsonResponse(response: MockResponse): Record<string, unknown> {
  expect(typeof response.body).toBe("string");
  return JSON.parse(response.body as string) as Record<string, unknown>;
}

describe("trajectory routes", () => {
  it("adds v5 event fields to trajectory detail responses", async () => {
    const trajectory = createTrajectory({
      metadata: {
        source: "test",
        contextObject: {
          id: "ctx-1",
          version: "v5",
          createdAt: 1_700_000_000_100,
          events: [
            {
              id: "ctx-instruction",
              type: "instruction",
              createdAt: 1_700_000_000_100,
              content: "Use the compact context.",
            },
            {
              id: "ctx-tool-call",
              type: "tool_call",
              createdAt: 1_700_000_000_200,
              toolName: "search_messages",
              input: { query: "latest invoice" },
              status: "completed",
              success: true,
            },
            {
              id: "ctx-cache",
              type: "cache_observation",
              createdAt: 1_700_000_000_300,
              cacheName: "message-context",
              key: "room:123",
              hit: true,
              tokenCount: 42,
            },
            {
              id: "ctx-diff",
              type: "context_diff",
              createdAt: 1_700_000_000_400,
              label: "message context",
              added: 1,
              removed: 0,
              changed: 2,
              tokenDelta: 12,
            },
          ],
        },
      },
    });
    const logger = createLogger({
      getTrajectoryDetail: vi.fn(async () => trajectory),
    });
    const response = createResponse();

    const handled = await handleTrajectoryRoute(
      createRequest(),
      response,
      createRuntime(logger),
      "/api/trajectories/traj-1",
      "GET",
    );

    expect(handled).toBe(true);
    const body = parseJsonResponse(response);
    expect(
      (body.contextEvents as unknown[]).map(
        (event) => (event as { id: string }).id,
      ),
    ).toEqual(["ctx-instruction", "ctx-tool-call", "ctx-cache", "ctx-diff"]);
    expect(body.toolEvents).toMatchObject([
      { id: "ctx-tool-call", type: "tool_call", toolName: "search_messages" },
    ]);
    expect(body.cacheObservations).toMatchObject([
      { id: "ctx-cache", type: "cache_observation", hit: true, tokenCount: 42 },
    ]);
    expect(body.cacheStats).toMatchObject({
      hits: 1,
      misses: 0,
      total: 1,
      tokenCount: 42,
    });
    expect(body.contextDiffs).toMatchObject([
      { id: "ctx-diff", type: "context_diff", added: 1, changed: 2 },
    ]);
    expect((body.events as unknown[]).length).toBeGreaterThanOrEqual(4);
  });

  it("preserves the base trajectory detail shape when v5 data is absent", async () => {
    const logger = createLogger({
      getTrajectoryDetail: vi.fn(async () => createTrajectory()),
    });
    const response = createResponse();

    await handleTrajectoryRoute(
      createRequest(),
      response,
      createRuntime(logger),
      "/api/trajectories/traj-1",
      "GET",
    );

    const body = parseJsonResponse(response);
    expect(body).toHaveProperty("trajectory");
    expect(body).toHaveProperty("llmCalls");
    expect(body).toHaveProperty("providerAccesses");
    expect(body).not.toHaveProperty("events");
    expect(body).not.toHaveProperty("contextEvents");
    expect(body).not.toHaveProperty("toolEvents");
    expect(body).not.toHaveProperty("cacheObservations");
    expect(body).not.toHaveProperty("cacheStats");
    expect(body).not.toHaveProperty("contextDiffs");
  });

  it("normalizes completed list rows with missing end timestamps", async () => {
    const logger = createLogger({
      listTrajectories: vi.fn(async () => ({
        trajectories: [
          {
            id: "traj-legacy",
            agentId: "agent-1",
            source: "runtime",
            status: "completed",
            startTime: 1_700_000_000_000,
            endTime: null,
            durationMs: null,
            llmCallCount: 0,
            providerAccessCount: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            createdAt: "2023-11-14T22:13:20.000Z",
            updatedAt: "2023-11-14T22:13:25.000Z",
            metadata: {},
          },
        ],
        total: 1,
        offset: 0,
        limit: 50,
      })),
    });
    const response = createResponse();

    await handleTrajectoryRoute(
      createRequest(),
      response,
      createRuntime(logger),
      "/api/trajectories",
      "GET",
    );

    const body = parseJsonResponse(response);
    const trajectories = body.trajectories as Array<Record<string, unknown>>;
    expect(trajectories[0]?.status).toBe("completed");
    expect(trajectories[0]?.endTime).toBe(1_700_000_005_000);
    expect(trajectories[0]?.durationMs).toBe(5_000);
    expect(trajectories[0]?.updatedAt).toBe("2023-11-14T22:13:25.000Z");
  });

  it("hydrates stale active list rows from trajectory detail before mapping", async () => {
    const logger = createLogger({
      listTrajectories: vi.fn(async () => ({
        trajectories: [
          {
            id: "traj-active",
            agentId: "agent-1",
            source: "runtime",
            status: "active",
            startTime: 1_700_000_000_000,
            endTime: null,
            durationMs: null,
            llmCallCount: 0,
            providerAccessCount: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            createdAt: "2023-11-14T22:13:20.000Z",
            updatedAt: "2023-11-14T22:13:21.000Z",
            metadata: {},
          },
        ],
        total: 1,
        offset: 0,
        limit: 50,
      })),
      getTrajectoryDetail: vi.fn(async () =>
        createTrajectory({
          trajectoryId: "traj-active",
          startTime: 1_700_000_000_000,
          endTime: 1_700_000_004_000,
          durationMs: 4_000,
          metadata: { source: "runtime" },
          metrics: { finalStatus: "completed" },
        }),
      ),
    });
    const response = createResponse();

    await handleTrajectoryRoute(
      createRequest(),
      response,
      createRuntime(logger),
      "/api/trajectories",
      "GET",
    );

    const body = parseJsonResponse(response);
    const trajectories = body.trajectories as Array<Record<string, unknown>>;
    expect(logger.getTrajectoryDetail).toHaveBeenCalledWith("traj-active");
    expect(trajectories[0]).toMatchObject({
      id: "traj-active",
      status: "completed",
      endTime: 1_700_000_004_000,
      durationMs: 4_000,
    });
  });

  it("rejects non-native JSON export shapes", async () => {
    const exportTrajectories = vi.fn();
    const logger = createLogger({ exportTrajectories });
    const response = createResponse();

    await handleTrajectoryRoute(
      createRequest({
        format: "json",
        jsonShape: "context_object_events_v5",
        includePrompts: true,
      }),
      response,
      createRuntime(logger),
      "/api/trajectories/export",
      "POST",
    );

    expect(exportTrajectories).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(String(response.body)).toContain("eliza_native_v1");
  });

  it("supports JSONL trajectory export", async () => {
    const exportTrajectories = vi.fn(async () => ({
      data: `${JSON.stringify({
        format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
        schemaVersion: 1,
        boundary: "vercel_ai_sdk.generateText",
        trajectoryId: "traj-1",
        agentId: "agent-1",
        stepId: "step-1",
        callId: "call-1",
        request: { prompt: "user" },
        response: { text: "resp" },
        metadata: { task_type: "response" },
      })}\n`,
      filename: "trajectories.eliza-native.jsonl",
      mimeType: "application/x-ndjson",
    }));
    const logger = createLogger({ exportTrajectories });
    const response = createResponse();

    await handleTrajectoryRoute(
      createRequest({
        format: "jsonl",
        jsonShape: ELIZA_NATIVE_TRAJECTORY_FORMAT,
        includePrompts: true,
      }),
      response,
      createRuntime(logger),
      "/api/trajectories/export",
      "POST",
    );

    expect(exportTrajectories).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "jsonl",
        jsonShape: ELIZA_NATIVE_TRAJECTORY_FORMAT,
        includePrompts: true,
      }),
    );
    expect(response.headers["content-type"]).toBe("application/x-ndjson");
    expect(typeof response.body).toBe("string");
    const lines = String(response.body).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
      trajectoryId: "traj-1",
    });
  });
});
