import type http from "node:http";
import { Readable } from "node:stream";
import type { Trajectory } from "@elizaos/agent/types/trajectory";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleTrajectoryRoute } from "./trajectory-routes";

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
  if (body === undefined) {
    return Readable.from([]) as http.IncomingMessage;
  }
  return Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as http.IncomingMessage;
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

  it("preserves the legacy trajectory detail shape when v5 data is absent", async () => {
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

  it("forwards context_object_events_v5 JSON export shape", async () => {
    const exportTrajectories = vi.fn(async () => ({
      data: "[]",
      filename: "trajectories.json",
      mimeType: "application/json",
    }));
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

    expect(exportTrajectories).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "json",
        jsonShape: "context_object_events_v5",
        includePrompts: true,
      }),
    );
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toBe("[]");
  });

  it("supports JSONL trajectory export", async () => {
    const exportTrajectories = vi.fn(async () => ({
      data: `${JSON.stringify({
        format: "trajectory_harness_v1",
        trajectoryId: "traj-1",
        callId: "call-1",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "user" },
          { role: "model", content: "resp" },
        ],
      })}\n`,
      filename: "trajectories.harness.jsonl",
      mimeType: "application/x-ndjson",
    }));
    const logger = createLogger({ exportTrajectories });
    const response = createResponse();

    await handleTrajectoryRoute(
      createRequest({
        format: "jsonl",
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
        includePrompts: true,
      }),
    );
    expect(response.headers["content-type"]).toBe("application/x-ndjson");
    expect(typeof response.body).toBe("string");
    const lines = String(response.body)
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      format: "trajectory_harness_v1",
      trajectoryId: "traj-1",
    });
  });
});
