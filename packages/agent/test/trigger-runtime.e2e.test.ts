import crypto from "node:crypto";
import http from "node:http";
import {
  type AgentRuntime,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonArray = JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

interface ApiResponse {
  status: number;
  data: JsonValue;
}

interface TriggerRuntimeHarness {
  runtime: AgentRuntime;
  injectAutonomousInstruction: ReturnType<typeof vi.fn>;
}

function parseJson(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return { raw };
  }
}

function asObject(value: JsonValue): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function asArray(value: JsonValue): JsonArray {
  if (!Array.isArray(value)) return [];
  return value;
}

function requestApi(
  port: number,
  method: string,
  path: string,
  body?: JsonObject,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({
            status: response.statusCode ?? 0,
            data: parseJson(raw),
          });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function createTriggerRuntimeHarness(): TriggerRuntimeHarness {
  let tasks: Task[] = [];
  const injectAutonomousInstruction = vi.fn(
    async (_params: {
      instructions: string;
      source: string;
      wakeMode: "inject_now" | "next_autonomy_cycle";
      triggerId: UUID;
      triggerTaskId: UUID;
    }) => undefined,
  );

  const runtimePartial: Partial<AgentRuntime> = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    character: { name: "TriggerRuntimeE2E" } as AgentRuntime["character"],
    getSetting: (_key: string) => undefined,
    getService: (serviceType: string) => {
      if (serviceType !== "AUTONOMY") return null;
      return {
        getAutonomousRoomId: () =>
          "00000000-0000-0000-0000-000000000201" as UUID,
        injectAutonomousInstruction,
      } as {
        getAutonomousRoomId: () => UUID;
        injectAutonomousInstruction: (params: {
          instructions: string;
          source: string;
          wakeMode: "inject_now" | "next_autonomy_cycle";
          triggerId: UUID;
          triggerTaskId: UUID;
        }) => Promise<void>;
      };
    },
    getTasks: async (query?: { tags?: string[] }) => {
      if (!query?.tags || query.tags.length === 0) return tasks;
      return tasks.filter((task) =>
        query.tags?.every((tag) => task.tags?.includes(tag)),
      );
    },
    getTask: async (taskId: UUID) =>
      tasks.find((task) => task.id === taskId) ?? null,
    getRoomsByWorld: async () => [],
    createTask: async (task: Task) => {
      const id = stringToUuid(crypto.randomUUID());
      const created: Task = {
        ...task,
        id,
      };
      tasks.push(created);
      return id;
    },
    updateTask: async (taskId: UUID, update: Partial<Task>) => {
      tasks = tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...update,
              metadata: {
                ...(task.metadata ?? {}),
                ...(update.metadata ?? {}),
              },
            }
          : task,
      );
    },
    deleteTask: async (taskId: UUID) => {
      tasks = tasks.filter((task) => task.id !== taskId);
    },
    createMemory: vi.fn(async () => undefined),
    getTaskWorker: vi.fn(),
    registerTaskWorker: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as AgentRuntime["logger"],
  };

  return {
    runtime: runtimePartial as AgentRuntime,
    injectAutonomousInstruction,
  };
}

describe("Trigger runtime E2E", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let harness: TriggerRuntimeHarness;

  beforeAll(async () => {
    harness = createTriggerRuntimeHarness();
    server = await startApiServer({
      port: 0,
      runtime: harness.runtime,
    });
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  it("creates a trigger, executes it, records run history, and dispatches autonomy", async () => {
    if (!server) {
      throw new Error("Server was not initialized");
    }

    const createResponse = await requestApi(
      server.port,
      "POST",
      "/api/triggers",
      {
        displayName: "Heartbeat runtime e2e",
        instructions: "Send a runtime heartbeat update",
        triggerType: "interval",
        intervalMs: 60_000,
        wakeMode: "inject_now",
      },
    );

    expect(createResponse.status).toBe(201);
    const createBody = asObject(createResponse.data);
    const trigger = asObject(createBody.trigger ?? null);
    const triggerId = String(trigger.id ?? "");
    expect(triggerId.length).toBeGreaterThan(0);

    const executeResponse = await requestApi(
      server.port,
      "POST",
      `/api/triggers/${encodeURIComponent(triggerId)}/execute`,
    );
    expect(executeResponse.status).toBe(200);
    const executeBody = asObject(executeResponse.data);
    const executeResult = asObject(executeBody.result ?? null);
    expect(executeResult.status).toBe("success");
    expect(harness.injectAutonomousInstruction).toHaveBeenCalledTimes(1);

    const runsResponse = await requestApi(
      server.port,
      "GET",
      `/api/triggers/${encodeURIComponent(triggerId)}/runs`,
    );
    expect(runsResponse.status).toBe(200);
    const runsBody = asObject(runsResponse.data);
    const runs = asArray(runsBody.runs ?? []);
    expect(runs.length).toBe(1);
    const run = asObject(runs[0] ?? null);
    expect(run.status).toBe("success");
    expect(run.source).toBe("manual");

    const healthResponse = await requestApi(
      server.port,
      "GET",
      "/api/triggers/health",
    );
    expect(healthResponse.status).toBe(200);
    const health = asObject(healthResponse.data);
    expect(Number(health.totalExecutions ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(health.totalFailures ?? 0)).toBe(0);
  });
});
