/**
 * Coverage for the `/api/trajectories/*` route handler (`handleTrajectoryRoute`),
 * with `@elizaos/agent`'s storage and zip helpers mocked so the routing, export,
 * and streaming branches are exercised without a real trajectory store.
 */
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
    setHeader(
      this: MockResponse,
      name: string,
      value: string | number | readonly string[],
    ) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(this: MockResponse, body?: string | Uint8Array) {
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

  it("delegates search to the SQL reader so matches past the first 500 rows are returned with a DB-wide total", async () => {
    // Seed 600 list items; only one (at index 550) carries the needle.
    // The old route re-fetched limit:500/offset:0 then filtered in memory,
    // which could never see index 550 and reported total as the match count
    // inside that 500-window. The fixed route passes `search` to the SQL
    // reader, which scans every row (id/scenario_id/batch_id/metadata/
    // steps_json) and returns the DB-wide COUNT.
    const NEEDLE = "needle-past-500";
    const seeded = Array.from({ length: 600 }, (_, index) => ({
      id: `traj-${index}`,
      agentId: "agent-1",
      source: "live",
      status: "completed" as const,
      startTime: 1_700_000_000_000 + index,
      endTime: 1_700_000_001_000 + index,
      durationMs: 1_000,
      llmCallCount: 1,
      providerAccessCount: 0,
      totalPromptTokens: 10,
      totalCompletionTokens: 5,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      // The needle lives in the persisted step content (steps_json) of one
      // row at index 550 — well past the legacy 500-row in-memory window.
      searchHaystack:
        index === 550 ? `user asked about ${NEEDLE}` : "unrelated",
    }));

    const listTrajectories = vi.fn(
      async (options: { limit?: number; offset?: number; search?: string }) => {
        const limit = options.limit ?? 50;
        const offset = options.offset ?? 0;
        const needle = options.search?.toLowerCase();
        const matched = needle
          ? seeded.filter((row) =>
              `${row.id} ${row.searchHaystack}`.toLowerCase().includes(needle),
            )
          : seeded;
        const page = matched
          .slice(offset, offset + limit)
          .map(({ searchHaystack: _ignored, ...item }) => item);
        return { trajectories: page, total: matched.length, offset, limit };
      },
    );

    const logger = createLogger({ listTrajectories });
    const response = createResponse();

    const request = createRequest() as http.IncomingMessage & {
      url?: string;
      headers: Record<string, string>;
    };
    request.url = `/api/trajectories?search=${NEEDLE}&limit=20&offset=0`;
    request.headers = { host: "localhost" };

    await handleTrajectoryRoute(
      request,
      response,
      createRuntime(logger),
      "/api/trajectories",
      "GET",
    );

    const body = parseJsonResponse(response);
    const trajectories = body.trajectories as Array<{ id: string }>;

    // (1) the match that lives past index 500 IS returned
    expect(trajectories.map((t) => t.id)).toContain("traj-550");
    // (2) total is the true DB-wide match count, not capped at the 500-window
    expect(body.total).toBe(1);
    expect(listTrajectories).toHaveBeenCalledWith(
      expect.objectContaining({ search: NEEDLE, limit: 20, offset: 0 }),
    );
  });
});
