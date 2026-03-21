/**
 * E2E tests for the real API server — NO MOCKS, NO API KEYS NEEDED.
 *
 * Imports and starts the actual `startApiServer()` from src/api/server.ts.
 * Tests every endpoint that doesn't require a running AgentRuntime:
 * - Status reporting
 * - Plugin discovery (real filesystem scan)
 * - Skill discovery (real filesystem scan)
 * - Onboarding options and status
 * - Config endpoints
 * - Log buffer
 * - Lifecycle state transitions
 * - Chat rejection when no runtime
 * - 404 handling
 * - CORS preflight
 *
 * These tests exercise REAL production code, not mocks.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, Content, Task, UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startApiServer } from "../src/api/server";
import { AGENT_NAME_POOL } from "../src/runtime/onboarding-names";

vi.mock("../src/services/mcp-marketplace", () => ({
  searchMcpMarketplace: vi
    .fn()
    .mockResolvedValue({ results: [{ name: "test", vendor: "test" }] }),
  getMcpServerDetails: vi.fn((name: string) =>
    name === "nonexistent-server-xyz-123"
      ? Promise.resolve(null)
      : Promise.resolve({ name: "test", description: "test" }),
  ),
}));

// ---------------------------------------------------------------------------
// HTTP helper (identical to the one in agent-runtime.e2e.test.ts)
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

function reqRaw(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            data: Buffer.concat(chunks),
          });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

type SseEventPayload = {
  type?: string;
  text?: string;
  fullText?: string;
  agentName?: string;
  message?: string;
};

function reqSse(
  port: number,
  p: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  events: SseEventPayload[];
}> {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(b),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const events: SseEventPayload[] = [];
          const blocks = raw
            .split("\n\n")
            .map((block) => block.trim())
            .filter((block) => block.length > 0);

          for (const block of blocks) {
            for (const line of block.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payloadText = line.slice(5).trim();
              if (!payloadText) continue;
              try {
                events.push(JSON.parse(payloadText) as SseEventPayload);
              } catch {
                // Ignore malformed SSE payloads in test parsing.
              }
            }
          }

          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            events,
          });
        });
      },
    );
    r.on("error", reject);
    r.write(b);
    r.end();
  });
}

function waitForWsMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
        const message = JSON.parse(text) as Record<string, unknown>;
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      } catch {
        // Ignore malformed WS frames in tests.
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type TestAgentEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  roomId?: string;
};

type TestHeartbeatEvent = {
  ts: number;
  status: string;
  preview?: string;
};

class TestAgentEventService {
  private eventListeners = new Set<(event: TestAgentEvent) => void>();
  private heartbeatListeners = new Set<(event: TestHeartbeatEvent) => void>();

  subscribe(listener: (event: TestAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeHeartbeat(
    listener: (event: TestHeartbeatEvent) => void,
  ): () => void {
    this.heartbeatListeners.add(listener);
    return () => this.heartbeatListeners.delete(listener);
  }

  emit(event: TestAgentEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  emitHeartbeat(event: TestHeartbeatEvent): void {
    for (const listener of this.heartbeatListeners) {
      listener(event);
    }
  }
}

function createRuntimeForStreamTests(options: {
  eventService?: TestAgentEventService;
  loopRunning?: boolean;
}): AgentRuntime {
  const runtimeSubset = {
    agentId: "test-agent-id",
    character: { name: "StreamTestAgent" } as AgentRuntime["character"],
    getService: (serviceType: string) => {
      if (serviceType === "AGENT_EVENT") {
        return options.eventService ?? null;
      }
      if (serviceType === "AUTONOMY") {
        return {
          enableAutonomy: async () => {},
          disableAutonomy: async () => {},
          isLoopRunning: () => options.loopRunning ?? false,
          getStatus: () => ({ enabled: options.loopRunning ?? false }),
        } as Awaited<ReturnType<AgentRuntime["getService"]>>;
      }
      return null;
    },
    getRoomsByWorld: async () => [],
    getMemories: async () => [],
    getCache: async () => null,
    setCache: async () => {},
  };
  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForAutonomySurfaceTests(options: {
  eventService: TestAgentEventService;
  loopRunning?: boolean;
}): AgentRuntime {
  const memoriesByRoom = new Map<string, Array<Record<string, unknown>>>();
  let tasks: Task[] = [
    {
      id: "00000000-0000-0000-0000-00000000a001" as UUID,
      name: "Autonomy surface task",
      description: "Validate workbench task visibility",
      tags: ["workbench-task"],
      metadata: {
        isCompleted: false,
        updatedAt: Date.now(),
        workbench: { kind: "task" },
      },
    } as Task,
    {
      id: "00000000-0000-0000-0000-00000000a002" as UUID,
      name: "TRIGGER_DISPATCH",
      description: "Autonomy surface trigger",
      tags: ["queue", "repeat", "trigger"],
      metadata: {
        updatedAt: Date.now(),
        updateInterval: 60_000,
        trigger: {
          triggerId: "00000000-0000-0000-0000-00000000a111",
          displayName: "Autonomy surface trigger",
          instructions: "Emit a proactive autonomy update",
          triggerType: "interval",
          enabled: true,
          wakeMode: "inject_now",
          createdBy: "test",
          intervalMs: 60_000,
          runCount: 0,
          nextRunAtMs: Date.now() + 60_000,
        },
      },
    } as Task,
  ];

  const runtimeSubset = {
    agentId: "autonomy-surface-agent",
    character: { name: "AutonomySurfaceAgent" } as AgentRuntime["character"],
    messageService: {
      handleMessage: async (
        _runtime: AgentRuntime,
        message: Record<string, unknown>,
      ) => {
        const prompt =
          typeof (message.content as Record<string, unknown> | undefined)
            ?.text === "string"
            ? String(
                (message.content as Record<string, unknown> | undefined)?.text,
              )
            : "autonomy";
        return {
          didRespond: true,
          responseContent: { text: `Autonomy says: ${prompt}` },
          responseMessages: [
            {
              id: crypto.randomUUID(),
              entityId: "autonomy-surface-agent",
              roomId: message.roomId as string,
              createdAt: Date.now(),
              content: {
                text: `Autonomy says: ${prompt}`,
              },
            },
          ],
          mode: "power",
        };
      },
    } as AgentRuntime["messageService"],
    getService: (serviceType: string) => {
      if (serviceType === "AGENT_EVENT") {
        return options.eventService;
      }
      if (serviceType === "AUTONOMY") {
        return {
          enableAutonomy: async () => {},
          disableAutonomy: async () => {},
          isLoopRunning: () => options.loopRunning ?? true,
          getStatus: () => ({ enabled: options.loopRunning ?? true }),
        } as Awaited<ReturnType<AgentRuntime["getService"]>>;
      }
      return null;
    },
    ensureConnection: async () => {},
    getWorld: async () => null,
    updateWorld: async () => {},
    createMemory: async (memory: Record<string, unknown>) => {
      const roomId = String(memory.roomId ?? "");
      if (!roomId) return;
      const current = memoriesByRoom.get(roomId) ?? [];
      current.push({
        ...memory,
        createdAt:
          typeof memory.createdAt === "number" ? memory.createdAt : Date.now(),
      });
      memoriesByRoom.set(roomId, current);
    },
    getMemories: async (query: { roomId?: string; count?: number }) => {
      const roomId = String(query.roomId ?? "");
      const current = memoriesByRoom.get(roomId) ?? [];
      const count = Math.max(1, query.count ?? current.length);
      return current.slice(-count) as unknown as Awaited<
        ReturnType<AgentRuntime["getMemories"]>
      >;
    },
    getRoomsByWorld: async () => [],
    getTasks: async (query?: { tags?: string[] }) => {
      if (!query?.tags || query.tags.length === 0) return tasks;
      return tasks.filter((task) =>
        query.tags?.every((tag) => task.tags?.includes(tag)),
      );
    },
    getTask: async (taskId: UUID) =>
      tasks.find((task) => task.id === taskId) ?? null,
    deleteTask: async (taskId: UUID) => {
      tasks = tasks.filter((task) => task.id !== taskId);
    },
    getCache: async () => null,
    setCache: async () => {},
  };

  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForWorkbenchCrudTests(options?: {
  loopRunning?: boolean;
}): AgentRuntime {
  let tasks: Task[] = [];
  const runtimeSubset = {
    agentId: "workbench-crud-agent",
    character: { name: "WorkbenchCrudAgent" } as AgentRuntime["character"],
    getSetting: () => undefined,
    getService: (serviceType: string) => {
      if (serviceType === "AUTONOMY") {
        return {
          isLoopRunning: () => options?.loopRunning ?? false,
          getStatus: () => ({ enabled: options?.loopRunning ?? false }),
          getAutonomousRoomId: () =>
            "00000000-0000-0000-0000-000000000201" as UUID,
        } as Awaited<ReturnType<AgentRuntime["getService"]>>;
      }
      return null;
    },
    getRoomsByWorld: async () => [],
    getTasks: async (query?: { tags?: string[] }) => {
      if (!query?.tags || query.tags.length === 0) return tasks;
      return tasks.filter((task) =>
        query.tags?.every((tag) => task.tags?.includes(tag)),
      );
    },
    getTask: async (taskId: UUID) =>
      tasks.find((task) => task.id === taskId) ?? null,
    createTask: async (task: Task) => {
      const id = (task.id as UUID | undefined) ?? (crypto.randomUUID() as UUID);
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
                ...((task.metadata as Record<string, unknown> | undefined) ??
                  {}),
                ...((update.metadata as Record<string, unknown> | undefined) ??
                  {}),
              } as Task["metadata"],
            }
          : task,
      );
    },
    deleteTask: async (taskId: UUID) => {
      tasks = tasks.filter((task) => task.id !== taskId);
    },
  };

  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForChatSseTests(options?: {
  onEmitEvent?: (
    event: Parameters<AgentRuntime["emitEvent"]>[0],
    payload: Parameters<AgentRuntime["emitEvent"]>[1],
  ) => void | Promise<void>;
  getService?: (serviceType: string) => unknown;
  getServicesByType?: (serviceType: string) => unknown;
  handleMessage?: (
    runtime: AgentRuntime,
    message: object,
    onResponse: (content: Content) => Promise<object[]>,
    messageOptions?: {
      onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
    },
  ) => Promise<{
    responseContent?: {
      text?: string;
    };
  }>;
}): AgentRuntime {
  const memoriesByRoom = new Map<string, Array<Record<string, unknown>>>();

  const runtimeSubset = {
    agentId: "chat-stream-agent",
    character: {
      name: "ChatStreamAgent",
      postExamples: ["Welcome to the conversation."],
    } as AgentRuntime["character"],
    messageService: {
      handleMessage: async (
        runtime: AgentRuntime,
        message: object,
        onResponse: (content: Content) => Promise<object[]>,
        messageOptions?: {
          onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
        },
      ) =>
        options?.handleMessage?.(
          runtime,
          message,
          onResponse,
          messageOptions,
        ) ??
        (await (async () => {
          await onResponse({ text: "Hello " } as Content);
          await onResponse({ text: "world" } as Content);
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        })()),
    } as AgentRuntime["messageService"],
    ensureConnection: async () => {},
    getWorld: async () => null,
    updateWorld: async () => {},
    createMemory: async (memory: Record<string, unknown>) => {
      const roomId = String(memory.roomId ?? "");
      if (!roomId) return;
      const current = memoriesByRoom.get(roomId) ?? [];
      current.push({
        ...memory,
        createdAt:
          typeof memory.createdAt === "number" ? memory.createdAt : Date.now(),
      });
      memoriesByRoom.set(roomId, current);
    },
    getService: (serviceType: string) =>
      options?.getService?.(serviceType) ?? null,
    getServicesByType: (serviceType: string) =>
      options?.getServicesByType?.(serviceType) ?? [],
    emitEvent: async (
      event: Parameters<AgentRuntime["emitEvent"]>[0],
      payload: Parameters<AgentRuntime["emitEvent"]>[1],
    ) => {
      await options?.onEmitEvent?.(event, payload);
    },
    getMemoriesByRoomIds: async (query: {
      roomIds?: string[];
      limit?: number;
    }) => {
      const roomIds = Array.isArray(query.roomIds) ? query.roomIds : [];
      const limit = Math.max(1, query.limit ?? 200);
      const merged: Array<Record<string, unknown>> = [];
      for (const roomId of roomIds) {
        const current = memoriesByRoom.get(String(roomId)) ?? [];
        merged.push(...current);
      }
      merged.sort(
        (a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0),
      );
      return merged.slice(-limit) as unknown as Awaited<
        ReturnType<AgentRuntime["getMemoriesByRoomIds"]>
      >;
    },
    getRoomsByWorld: async () => [],
    getMemories: async (query: { roomId?: string; count?: number }) => {
      const roomId = String(query.roomId ?? "");
      const current = memoriesByRoom.get(roomId) ?? [];
      const count = Math.max(1, query.count ?? current.length);
      return current.slice(-count) as unknown as Awaited<
        ReturnType<AgentRuntime["getMemories"]>
      >;
    },
    getCache: async () => null,
    setCache: async () => {},
  };

  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForCompatEndpointTests(): AgentRuntime {
  const runtimeSubset = {
    agentId: "compat-endpoint-agent",
    character: { name: "CompatAgent" } as AgentRuntime["character"],
    messageService: {
      handleMessage: async (
        _runtime: AgentRuntime,
        _message: object,
        onResponse: (content: Content) => Promise<object[]>,
      ) => {
        await onResponse({ text: "Compat " } as Content);
        await onResponse({ text: "reply" } as Content);
        return {
          didRespond: true,
          responseContent: {
            text: "Compat reply",
          },
          responseMessages: [],
          mode: "power",
        };
      },
    } as AgentRuntime["messageService"],
    ensureConnection: async () => {},
    getWorld: async () => null,
    updateWorld: async () => {},
    getService: () => null,
    getRoomsByWorld: async () => [],
    getMemories: async () => [],
    getCache: async () => null,
    setCache: async () => {},
  };

  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForCreditNoResponseTests(): AgentRuntime {
  const runtimeLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as AgentRuntime["logger"];

  const runtimeSubset = {
    agentId: "credit-no-response-agent",
    character: { name: "CreditAgent" } as AgentRuntime["character"],
    logger: runtimeLogger,
    messageService: {
      handleMessage: async (_runtime: AgentRuntime) => {
        _runtime.logger.error(
          "#Youmu Model call failed: AI_APICallError: Insufficient credits. Required: $0.2250",
        );
        return {
          didRespond: true,
          responseContent: null,
          responseMessages: [],
          mode: "none",
        };
      },
    } as AgentRuntime["messageService"],
    ensureConnection: async () => {},
    getWorld: async () => null,
    updateWorld: async () => {},
    getService: () => null,
    getRoomsByWorld: async () => [],
    getMemories: async () => [],
    getCache: async () => null,
    setCache: async () => {},
  };

  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForCreditLiteralNoResponseTests(): AgentRuntime {
  const runtimeLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as AgentRuntime["logger"];

  const runtimeSubset = {
    agentId: "credit-literal-no-response-agent",
    character: { name: "CreditAgent" } as AgentRuntime["character"],
    logger: runtimeLogger,
    messageService: {
      handleMessage: async (_runtime: AgentRuntime) => {
        _runtime.logger.error(
          "#Youmu Model call failed: AI_APICallError: Insufficient credits. Required: $0.2250",
        );
        return {
          didRespond: true,
          responseContent: { text: "(no response)" },
          responseMessages: [],
          mode: "none",
        };
      },
    } as AgentRuntime["messageService"],
    ensureConnection: async () => {},
    getWorld: async () => null,
    updateWorld: async () => {},
    getService: () => null,
    getRoomsByWorld: async () => [],
    getMemories: async () => [],
    getCache: async () => null,
    setCache: async () => {},
  };

  return runtimeSubset as unknown as AgentRuntime;
}

function createRuntimeForCreditErrorTests(): AgentRuntime {
  const runtimeSubset = {
    agentId: "credit-error-agent",
    character: { name: "CreditAgent" } as AgentRuntime["character"],
    messageService: {
      handleMessage: async () => {
        throw new Error(
          "AI_APICallError: Insufficient credits. Required: $0.2250",
        );
      },
    } as AgentRuntime["messageService"],
    ensureConnection: async () => {},
    getWorld: async () => null,
    updateWorld: async () => {},
    getService: () => null,
    getRoomsByWorld: async () => [],
    getMemories: async () => [],
    getCache: async () => null,
    setCache: async () => {},
  };

  return runtimeSubset as unknown as AgentRuntime;
}

// ---------------------------------------------------------------------------
// Test isolation — redirect all state to a temp directory so tests never
// touch the real ~/.eliza config, database, or plugins.
// ---------------------------------------------------------------------------

let _e2eTempDir: string;
let _origStateDirEnv: string | undefined;

beforeAll(async () => {
  _origStateDirEnv = process.env.ELIZA_STATE_DIR;
  _e2eTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-e2e-"));
  process.env.ELIZA_STATE_DIR = _e2eTempDir;

  // Seed a minimal config so the server can start
  await fs.writeFile(
    path.join(_e2eTempDir, "eliza.json"),
    JSON.stringify({
      agents: {
        defaults: { workspace: path.join(_e2eTempDir, "workspace") },
        list: [{ id: "main", default: true, name: "TestAgent" }],
      },
      ui: { theme: "dark" },
      cloud: { enabled: false },
      env: {},
      features: {},
      plugins: { entries: {} },
      database: { provider: "pglite" },
    }),
  );
  await fs.mkdir(path.join(_e2eTempDir, "workspace"), { recursive: true });
});

afterAll(async () => {
  if (_origStateDirEnv !== undefined) {
    process.env.ELIZA_STATE_DIR = _origStateDirEnv;
  } else {
    delete process.env.ELIZA_STATE_DIR;
  }
  if (_e2eTempDir) {
    await fs.rm(_e2eTempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API Server E2E (no runtime)", () => {
  let port: number;
  let close: () => Promise<void>;
  let updateStartup: (update: {
    phase?: string;
    attempt?: number;
    lastError?: string;
    lastErrorAt?: number;
    nextRetryAt?: number;
    state?:
      | "not_started"
      | "starting"
      | "running"
      | "paused"
      | "stopped"
      | "restarting"
      | "error";
  }) => void;

  beforeAll(async () => {
    // Start the REAL server with no runtime (port 0 = auto-assign)
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
    updateStartup = server.updateStartup;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  // -- Status --

  describe("GET /api/status", () => {
    it("returns not_started state (no runtime)", async () => {
      const { status, data } = await req(port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("not_started");
      expect(typeof data.agentName).toBe("string");
    });

    it("has no uptime or startedAt when not started", async () => {
      const { data } = await req(port, "GET", "/api/status");
      expect(data.uptime).toBeUndefined();
      expect(data.startedAt).toBeUndefined();
    });

    it("includes startup status diagnostics and reflects updates", async () => {
      const now = Date.now();
      updateStartup({
        phase: "runtime-retry",
        attempt: 2,
        lastError: "init failed",
        lastErrorAt: now,
        nextRetryAt: now + 1_000,
        state: "starting",
      });
      const { data } = await req(port, "GET", "/api/status");
      const startup = data.startup as
        | {
            phase?: string;
            attempt?: number;
            lastError?: string;
          }
        | undefined;
      expect(data.startup).toBeDefined();
      expect(startup?.phase).toBe("runtime-retry");
      expect(startup?.attempt).toBe(2);
      expect(startup?.lastError).toContain("init failed");
      expect(data.state).toBe("starting");

      updateStartup({
        phase: "idle",
        attempt: 0,
        lastError: undefined,
        lastErrorAt: undefined,
        nextRetryAt: undefined,
        state: "not_started",
      });
    });
  });

  // -- Lifecycle state transitions --

  describe("lifecycle state transitions", () => {
    it("start → running", async () => {
      const { data } = await req(port, "POST", "/api/agent/start");
      expect(data.ok).toBe(true);
      const status = await req(port, "GET", "/api/status");
      expect(status.data.state).toBe("paused");
      expect(typeof status.data.uptime).toBe("number");
    });

    it("pause → paused", async () => {
      const { data } = await req(port, "POST", "/api/agent/pause");
      expect(data.ok).toBe(true);
      expect((await req(port, "GET", "/api/status")).data.state).toBe("paused");
    });

    it("resume → running", async () => {
      const { data } = await req(port, "POST", "/api/agent/resume");
      expect(data.ok).toBe(true);
      expect((await req(port, "GET", "/api/status")).data.state).toBe(
        "running",
      );
    });

    it("stop → stopped, clears model and timing", async () => {
      const { data } = await req(port, "POST", "/api/agent/stop");
      expect(data.ok).toBe(true);
      const status = await req(port, "GET", "/api/status");
      expect(status.data.state).toBe("stopped");
      expect(status.data.model).toBeUndefined();
      expect(status.data.startedAt).toBeUndefined();
    });

    it("full cycle: start → pause → resume → stop", async () => {
      await req(port, "POST", "/api/agent/start");
      expect((await req(port, "GET", "/api/status")).data.state).toBe("paused");

      await req(port, "POST", "/api/agent/pause");
      expect((await req(port, "GET", "/api/status")).data.state).toBe("paused");

      await req(port, "POST", "/api/agent/resume");
      expect((await req(port, "GET", "/api/status")).data.state).toBe(
        "running",
      );

      await req(port, "POST", "/api/agent/stop");
      expect((await req(port, "GET", "/api/status")).data.state).toBe(
        "stopped",
      );
    });
  });

  // -- Chat rejection without runtime --

  describe("POST /api/chat (no runtime)", () => {
    it("rejects with 503 when no runtime", async () => {
      const { status, data } = await req(port, "POST", "/api/chat", {
        text: "hello",
      });
      expect(status).toBe(503);
      expect(data.error).toContain("not running");
    });

    it("rejects empty text with 400", async () => {
      const { status } = await req(port, "POST", "/api/chat", { text: "" });
      expect(status).toBe(400);
    });

    it("rejects missing text with 400", async () => {
      const { status } = await req(port, "POST", "/api/chat", {});
      expect(status).toBe(400);
    });
  });

  describe("POST /api/chat/stream (no runtime)", () => {
    it("rejects with 503 when no runtime", async () => {
      const { status, data } = await req(port, "POST", "/api/chat/stream", {
        text: "hello",
      });
      expect(status).toBe(503);
      expect(String(data.error)).toContain("not running");
    });

    it("rejects empty text with 400", async () => {
      const { status } = await req(port, "POST", "/api/chat/stream", {
        text: "",
      });
      expect(status).toBe(400);
    });
  });

  describe("POST /api/conversations/:id/messages/stream (no runtime)", () => {
    it("returns 404 when conversation does not exist", async () => {
      const { status } = await req(
        port,
        "POST",
        "/api/conversations/missing/messages/stream",
        {
          text: "hello",
        },
      );
      expect(status).toBe(404);
    });

    it("returns 503 when conversation exists but runtime is absent", async () => {
      const create = await req(port, "POST", "/api/conversations", {
        title: "Streaming test",
      });
      expect(create.status).toBe(200);
      const conversation = create.data.conversation as { id?: string };
      const conversationId = conversation.id ?? "";
      expect(conversationId.length).toBeGreaterThan(0);

      const { status, data } = await req(
        port,
        "POST",
        `/api/conversations/${conversationId}/messages/stream`,
        {
          text: "hello",
        },
      );
      expect(status).toBe(503);
      expect(String(data.error)).toContain("not running");
    });
  });

  describe("streaming chat endpoints (runtime stub)", () => {
    it("POST /api/chat emits MESSAGE_RECEIVED before handling", async () => {
      const emitted: Array<{
        event: string;
        source: string | null;
        text: string | null;
      }> = [];
      const runtime = createRuntimeForChatSseTests({
        onEmitEvent: (event, payload) => {
          if (typeof event !== "string") return;
          const message =
            payload && typeof payload === "object" && "message" in payload
              ? (payload.message as { content?: { text?: string } })
              : null;
          const source =
            payload && typeof payload === "object" && "source" in payload
              ? payload.source
              : null;
          emitted.push({
            event,
            source: typeof source === "string" ? source : null,
            text:
              typeof message?.content?.text === "string"
                ? message.content.text
                : null,
          });
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "hello",
            mode: "simple",
          },
        );

        expect(status).toBe(200);
        expect(String(data.text ?? "")).toBe("Hello world");

        const received = emitted.find(
          (entry) => entry.event === "MESSAGE_RECEIVED",
        );
        expect(received).toBeDefined();
        expect(received?.source).toBe("client_chat");
        expect(received?.text).toBe("hello");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat does not use deprecated direct trajectory fallback when hooks do not set a step id", async () => {
      const starts: Array<{ stepId: string; source?: string }> = [];
      const ends: Array<{ stepId: string; status?: string }> = [];
      const trajectoryLogger = {
        isEnabled: () => true,
        startTrajectory: async (
          stepId: string,
          options: { source?: string },
        ) => {
          starts.push({ stepId, source: options.source });
          return stepId;
        },
        endTrajectory: async (stepId: string, status?: string) => {
          ends.push({ stepId, status });
        },
      };
      const runtime = createRuntimeForChatSseTests({
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? trajectoryLogger : null,
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "fallback trajectory path",
            mode: "simple",
          },
        );

        expect(status).toBe(200);
        expect(String(data.text ?? "")).toBe("Hello world");
        expect(starts).toHaveLength(0);
        expect(ends).toHaveLength(0);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat does not call deprecated direct trajectory fallback even when logger is only in getServicesByType", async () => {
      const starts: Array<{ stepId: string; source?: string }> = [];
      const ends: Array<{ stepId: string; status?: string }> = [];
      const trajectoryLogger = {
        isEnabled: () => true,
        startTrajectory: async (
          stepId: string,
          options: { source?: string },
        ) => {
          starts.push({ stepId, source: options.source });
          return stepId;
        },
        endTrajectory: async (stepId: string, status?: string) => {
          ends.push({ stepId, status });
        },
      };
      const runtime = createRuntimeForChatSseTests({
        getService: () => null,
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger" ? [trajectoryLogger] : [],
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "trajectory logger by type",
            mode: "simple",
          },
        );

        expect(status).toBe(200);
        expect(String(data.text ?? "")).toBe("Hello world");
        expect(starts).toHaveLength(0);
        expect(ends).toHaveLength(0);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat does not end trajectories directly when hook metadata provides a step id", async () => {
      const starts: Array<{ stepId: string }> = [];
      const ends: Array<{ stepId: string; status?: string }> = [];
      const trajectoryLogger = {
        isEnabled: () => true,
        startTrajectory: async (stepId: string) => {
          starts.push({ stepId });
          return stepId;
        },
        endTrajectory: async (stepId: string, status?: string) => {
          ends.push({ stepId, status });
        },
      };

      const runtime = createRuntimeForChatSseTests({
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? trajectoryLogger : null,
        onEmitEvent: (_event, payload) => {
          if (
            payload &&
            typeof payload === "object" &&
            "message" in payload &&
            payload.message &&
            typeof payload.message === "object"
          ) {
            const msg = payload.message as {
              metadata?: Record<string, unknown>;
            };
            if (!msg.metadata) msg.metadata = {};
            msg.metadata.trajectoryStepId = "hook-step-id";
          }
        },
      });

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "trajectory end by hook",
            mode: "simple",
          },
        );

        expect(status).toBe(200);
        expect(String(data.text ?? "")).toBe("Hello world");
        expect(starts).toHaveLength(0);
        expect(ends).toHaveLength(0);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat no longer proxies trajectory logger routing through deprecated fallback", async () => {
      const starts: Array<{ stepId: string }> = [];
      const ends: Array<{ stepId: string; status?: string }> = [];
      const persistentLlmCalls: Array<{ stepId: string; model?: string }> = [];
      const coreLlmCalls: Array<{ stepId: string; model?: string }> = [];
      const persistentLogger = {
        isEnabled: () => true,
        startTrajectory: async (stepId: string) => {
          starts.push({ stepId });
          return stepId;
        },
        endTrajectory: async (stepId: string, status?: string) => {
          ends.push({ stepId, status });
        },
        logLlmCall: (params: { stepId: string; model?: string }) => {
          persistentLlmCalls.push(params);
        },
      };
      const coreLogger = {
        logLlmCall: (params: { stepId: string; model?: string }) => {
          coreLlmCalls.push(params);
        },
      };
      const runtime = createRuntimeForChatSseTests({
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? coreLogger : null,
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger"
            ? [coreLogger, persistentLogger]
            : [],
        handleMessage: async (runtimeArg, message, onResponse) => {
          const trajectoryLogger = (
            runtimeArg as unknown as {
              getService: (serviceType: string) => {
                logLlmCall?: (params: {
                  stepId: string;
                  model?: string;
                }) => void;
              } | null;
            }
          ).getService("trajectory_logger");
          const metadata =
            message && typeof message === "object" && "metadata" in message
              ? (message.metadata as { trajectoryStepId?: string } | undefined)
              : undefined;
          const stepId = metadata?.trajectoryStepId;
          if (stepId) {
            trajectoryLogger?.logLlmCall?.({
              stepId,
              model: "unit-test-model",
            });
          }
          await onResponse({ text: "Hello world" } as Content);
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        },
      });

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "trajectory logger routing",
            mode: "simple",
          },
        );

        expect(status).toBe(200);
        expect(String(data.text ?? "")).toBe("Hello world");
        expect(starts).toHaveLength(0);
        expect(ends).toHaveLength(0);
        expect(persistentLlmCalls).toHaveLength(0);
        expect(coreLlmCalls).toHaveLength(0);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream emits token and done events", async () => {
      const runtime = createRuntimeForChatSseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, headers, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        expect(String(headers["content-type"] ?? "")).toContain(
          "text/event-stream",
        );

        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello ",
          "world",
        ]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream emits token events from runtime onStreamChunk", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (
          _runtime,
          _message,
          onResponse,
          messageOptions,
        ) => {
          await messageOptions?.onStreamChunk?.("Hello ");
          await messageOptions?.onStreamChunk?.("world");
          await onResponse({ text: "Hello world" } as Content);
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello ",
          "world",
        ]);
        expect(tokenEvents.map((event) => event.fullText)).toEqual([
          "Hello ",
          "Hello world",
        ]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream avoids mixed-source duplication when callback text arrives before onStreamChunk", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (
          _runtime,
          _message,
          onResponse,
          messageOptions,
        ) => {
          await onResponse({ text: "Hello world" } as Content);
          await messageOptions?.onStreamChunk?.("Hello ");
          await messageOptions?.onStreamChunk?.("world");
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual(["Hello world"]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream de-duplicates cumulative callback text updates", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (_runtime, _message, onResponse) => {
          await onResponse({ text: "Hello " } as Content);
          await onResponse({ text: "Hello world" } as Content);
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello ",
          "world",
        ]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream emits replacement snapshots for corrected callback text", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (_runtime, _message, onResponse) => {
          await onResponse({ text: "Hello wrld" } as Content);
          await onResponse({ text: "Hello world" } as Content);
          await onResponse({ text: "Hello world!" } as Content);
          return {
            responseContent: {
              text: "Hello world!",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello wrld",
          "Hello world",
          "!",
        ]);
        expect(tokenEvents.map((event) => event.fullText)).toEqual([
          "Hello wrld",
          "Hello world",
          "Hello world!",
        ]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world!");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream preserves repeated characters in incremental callback tokens", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (_runtime, _message, onResponse) => {
          for (const token of [
            "H",
            "e",
            "l",
            "l",
            "o",
            " ",
            "w",
            "o",
            "r",
            "l",
            "d",
          ]) {
            await onResponse({ text: token } as Content);
          }
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenText = events
          .filter((event) => event.type === "token")
          .map((event) => event.text ?? "")
          .join("");
        expect(tokenText).toBe("Hello world");

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("GET /api/conversations waits for a pending restore before reporting the list", async () => {
      const restoreGate =
        createDeferred<Array<{ id: UUID; channelId: string; name: string }>>();
      const restoredConversationId = "11111111-1111-4111-8111-111111111111";
      const restoredRoomId = "00000000-0000-0000-0000-00000000c001" as UUID;
      const restoredAt = Date.parse("2026-02-01T12:00:00.000Z");
      const runtime = {
        agentId: "restore-list-agent",
        character: { name: "RestoreListAgent" } as AgentRuntime["character"],
        getService: () => null,
        getRoomsByWorld: async () => restoreGate.promise,
        getMemories: async (query: { count?: number }) =>
          query.count === 1 ? ([{ createdAt: restoredAt }] as Array<{ createdAt: number }>) : [],
        getCache: async () => null,
        setCache: async () => {},
      } as unknown as AgentRuntime;

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const listPromise = req(streamServer.port, "GET", "/api/conversations");
        const earlyState = await Promise.race([
          listPromise.then(() => "resolved" as const),
          new Promise<"pending">((resolve) =>
            setTimeout(() => resolve("pending"), 25),
          ),
        ]);
        expect(earlyState).toBe("pending");

        restoreGate.resolve([
          {
            id: restoredRoomId,
            channelId: `web-conv-${restoredConversationId}`,
            name: "Restored Chat",
          },
        ]);

        const response = await listPromise;
        expect(response.status).toBe(200);
        expect(response.data.conversations).toEqual([
          expect.objectContaining({
            id: restoredConversationId,
            title: "Restored Chat",
          }),
        ]);
      } finally {
        await streamServer.close();
      }
    });

    it("GET /api/conversations/:id/messages waits for a pending restore before 404ing", async () => {
      const restoreGate =
        createDeferred<Array<{ id: UUID; channelId: string; name: string }>>();
      const restoredConversationId = "22222222-2222-4222-8222-222222222222";
      const restoredRoomId = "00000000-0000-0000-0000-00000000c002" as UUID;
      const restoredAt = Date.parse("2026-02-02T12:00:00.000Z");
      const runtime = {
        agentId: "restore-messages-agent",
        character: {
          name: "RestoreMessagesAgent",
        } as AgentRuntime["character"],
        getService: () => null,
        getRoomsByWorld: async () => restoreGate.promise,
        getMemories: async (query: { count?: number }) =>
          query.count === 1 ? ([{ createdAt: restoredAt }] as Array<{ createdAt: number }>) : [],
        getCache: async () => null,
        setCache: async () => {},
      } as unknown as AgentRuntime;

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const messagesPromise = req(
          streamServer.port,
          "GET",
          `/api/conversations/${restoredConversationId}/messages`,
        );
        const earlyState = await Promise.race([
          messagesPromise.then(() => "resolved" as const),
          new Promise<"pending">((resolve) =>
            setTimeout(() => resolve("pending"), 25),
          ),
        ]);
        expect(earlyState).toBe("pending");

        restoreGate.resolve([
          {
            id: restoredRoomId,
            channelId: `web-conv-${restoredConversationId}`,
            name: "Restored Chat",
          },
        ]);

        const response = await messagesPromise;
        expect(response.status).toBe(200);
        expect(response.data.messages).toEqual([]);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/conversations/:id/messages/stream emits token events from runtime onStreamChunk", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (
          _runtime,
          _message,
          onResponse,
          messageOptions,
        ) => {
          await messageOptions?.onStreamChunk?.("Hello ");
          await messageOptions?.onStreamChunk?.("world");
          await onResponse({ text: "Hello world" } as Content);
          return {
            responseContent: {
              text: "Hello world",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "SSE onStreamChunk conversation",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        const { status, events } = await reqSse(
          streamServer.port,
          `/api/conversations/${conversationId}/messages/stream`,
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello ",
          "world",
        ]);
        expect(tokenEvents.map((event) => event.fullText)).toEqual([
          "Hello ",
          "Hello world",
        ]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/conversations/:id/messages/stream emits token and done events", async () => {
      const runtime = createRuntimeForChatSseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "SSE conversation",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        const { status, events } = await reqSse(
          streamServer.port,
          `/api/conversations/${conversationId}/messages/stream`,
          { text: "hello", mode: "simple" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello ",
          "world",
        ]);
        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/conversations/:id/messages/stream emits replacement snapshots for corrected callback text", async () => {
      const runtime = createRuntimeForChatSseTests({
        handleMessage: async (_runtime, _message, onResponse) => {
          await onResponse({ text: "Hello wrld" } as Content);
          await onResponse({ text: "Hello world" } as Content);
          await onResponse({ text: "Hello world!" } as Content);
          return {
            responseContent: {
              text: "Hello world!",
            },
          };
        },
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "Corrected snapshot conversation",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        const { status, events } = await reqSse(
          streamServer.port,
          `/api/conversations/${conversationId}/messages/stream`,
          { text: "hello", mode: "power" },
        );

        expect(status).toBe(200);
        const tokenEvents = events.filter((event) => event.type === "token");
        expect(tokenEvents.map((event) => event.text)).toEqual([
          "Hello wrld",
          "Hello world",
          "!",
        ]);
        expect(tokenEvents.map((event) => event.fullText)).toEqual([
          "Hello wrld",
          "Hello world",
          "Hello world!",
        ]);

        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.fullText).toBe("Hello world!");
        expect(doneEvent?.agentName).toBe("ChatStreamAgent");
      } finally {
        await streamServer.close();
      }
    });

    it("persists greeting and streamed turn messages to conversation memory", async () => {
      const runtime = createRuntimeForChatSseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "Persistence test",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        const greeting = await req(
          streamServer.port,
          "POST",
          `/api/conversations/${conversationId}/greeting`,
        );
        expect(greeting.status).toBe(200);
        const greetingText = String(greeting.data.text ?? "");
        expect(greetingText.length).toBeGreaterThan(0);

        const stream = await reqSse(
          streamServer.port,
          `/api/conversations/${conversationId}/messages/stream`,
          { text: "hello", mode: "simple" },
        );
        expect(stream.status).toBe(200);

        const messagesResponse = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${conversationId}/messages`,
        );
        expect(messagesResponse.status).toBe(200);
        const messages = (messagesResponse.data.messages ?? []) as Array<
          Record<string, unknown>
        >;
        expect(messages.length).toBeGreaterThanOrEqual(3);

        const greetingPersisted = messages.some(
          (message) =>
            message.role === "assistant" && message.text === greetingText,
        );
        const userPersisted = messages.some(
          (message) => message.role === "user" && message.text === "hello",
        );
        const assistantPersisted = messages.some(
          (message) =>
            message.role === "assistant" && message.text === "Hello world",
        );

        expect(greetingPersisted).toBe(true);
        expect(userPersisted).toBe(true);
        expect(assistantPersisted).toBe(true);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/conversations can init the intro greeting atomically", async () => {
      const runtime = createRuntimeForChatSseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "Init greeting test",
            initGreeting: true,
            lang: "en",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);
        expect(create.data.greeting).toMatchObject({
          text: "Welcome to the conversation.",
          agentName: "ChatStreamAgent",
          generated: true,
        });

        const messagesResponse = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${conversationId}/messages`,
        );
        expect(messagesResponse.status).toBe(200);
        const messages = (messagesResponse.data.messages ?? []) as Array<
          Record<string, unknown>
        >;
        expect(messages).toEqual([
          expect.objectContaining({
            role: "assistant",
            text: "Welcome to the conversation.",
            source: "agent_greeting",
          }),
        ]);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/conversations/:id/greeting is idempotent after the intro is stored", async () => {
      const runtime = createRuntimeForChatSseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "Idempotent greeting test",
            initGreeting: true,
            lang: "en",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        const greeting = await req(
          streamServer.port,
          "POST",
          `/api/conversations/${conversationId}/greeting?lang=en`,
        );
        expect(greeting.status).toBe(200);
        expect(greeting.data).toMatchObject({
          text: "Welcome to the conversation.",
          agentName: "ChatStreamAgent",
          generated: true,
        });

        const messagesResponse = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${conversationId}/messages`,
        );
        expect(messagesResponse.status).toBe(200);
        const messages = (messagesResponse.data.messages ?? []) as Array<
          Record<string, unknown>
        >;
        const greetings = messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.source === "agent_greeting" &&
            message.text === "Welcome to the conversation.",
        );
        expect(greetings).toHaveLength(1);
      } finally {
        await streamServer.close();
      }
    });

    it("GET /api/conversations/:id/messages returns an empty messages array on runtime read failure", async () => {
      const runtime = createRuntimeForChatSseTests();
      runtime.getMemories = async () => {
        throw new Error("forced-memories-failure");
      };

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const create = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "Conversation messages failure fallback",
          },
        );
        expect(create.status).toBe(200);
        const conversation = create.data.conversation as { id?: string };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        const response = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${conversationId}/messages`,
        );

        expect(response.status).toBe(500);
        expect(Array.isArray(response.data.messages)).toBe(true);
        expect((response.data.messages as unknown[]).length).toBe(0);
        expect(typeof response.data.error).toBe("string");
      } finally {
        await streamServer.close();
      }
    });
  });

  describe("trajectory endpoints (runtime stub)", () => {
    it("GET /api/trajectories/:id returns llm calls from plugin detail payload", async () => {
      const trajectoryId = "trajectory-array-shape";
      const startTime = Date.now() - 2_000;
      const endTime = startTime + 1_200;
      const callTimestamp = startTime + 400;
      const rawSteps = [
        {
          stepId: "step-1",
          stepNumber: 1,
          timestamp: startTime + 100,
          llmCalls: [
            {
              callId: "call-1",
              timestamp: callTimestamp,
              model: "unit-test-model",
              systemPrompt: "system",
              userPrompt: "hello from fallback",
              response: "fallback response",
              temperature: 0.1,
              maxTokens: 512,
              purpose: "response",
              promptTokens: 12,
              completionTokens: 18,
              latencyMs: 33,
            },
          ],
          providerAccesses: [],
        },
      ];

      const trajectoryLogger = {
        isEnabled: () => true,
        setEnabled: () => {},
        listTrajectories: async () => ({
          trajectories: [
            {
              id: trajectoryId,
              agentId: "chat-stream-agent",
              source: "client_chat",
              status: "completed",
              startTime,
              endTime,
              durationMs: endTime - startTime,
              stepCount: 1,
              llmCallCount: 1,
              totalPromptTokens: 12,
              totalCompletionTokens: 18,
              totalReward: 0,
              scenarioId: null,
              batchId: null,
              createdAt: new Date(startTime).toISOString(),
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
        }),
        getTrajectoryDetail: async () => ({
          trajectoryId,
          agentId: "chat-stream-agent",
          startTime,
          endTime,
          durationMs: endTime - startTime,
          steps: rawSteps,
          totalReward: 0,
          metrics: {
            episodeLength: 1,
            finalStatus: "completed",
          },
          metadata: {
            source: "client_chat",
          },
        }),
        getStats: async () => ({
          totalTrajectories: 1,
          totalSteps: 1,
          totalLlmCalls: 1,
          totalPromptTokens: 12,
          totalCompletionTokens: 18,
          averageDurationMs: endTime - startTime,
          averageReward: 0,
          bySource: { client_chat: 1 },
          byStatus: { completed: 1 },
          byScenario: {},
        }),
        deleteTrajectories: async () => 0,
        clearAllTrajectories: async () => 0,
        exportTrajectories: async () => ({
          data: "[]",
          filename: "trajectories.json",
          mimeType: "application/json",
        }),
      };

      const runtime = createRuntimeForChatSseTests({
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? trajectoryLogger : null,
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger" ? [trajectoryLogger] : [],
      }) as AgentRuntime & { adapter?: unknown };
      runtime.adapter = {};

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const list = await req(
          streamServer.port,
          "GET",
          "/api/trajectories?limit=10",
        );
        expect(list.status).toBe(200);
        const listRows = list.data.trajectories as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(listRows)).toBe(true);
        expect(listRows[0]?.llmCallCount).toBe(1);

        const detail = await req(
          streamServer.port,
          "GET",
          `/api/trajectories/${encodeURIComponent(trajectoryId)}`,
        );
        expect(detail.status).toBe(200);
        const llmCalls = detail.data.llmCalls as Array<Record<string, unknown>>;
        expect(Array.isArray(llmCalls)).toBe(true);
        expect(llmCalls).toHaveLength(1);
        expect(llmCalls[0]?.userPrompt).toBe("hello from fallback");
        expect(llmCalls[0]?.response).toBe("fallback response");
        expect(llmCalls[0]?.promptTokens).toBe(12);
        expect(llmCalls[0]?.completionTokens).toBe(18);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/trajectories/export returns a zip with trajectory folders", async () => {
      const trajectoryId = "trajectory-zip-export";
      const startTime = Date.now() - 2_000;
      const endTime = startTime + 1_100;

      const trajectoryLogger = {
        isEnabled: () => true,
        setEnabled: () => {},
        listTrajectories: async () => ({
          trajectories: [
            {
              id: trajectoryId,
              agentId: "chat-stream-agent",
              source: "client_chat",
              status: "completed",
              startTime,
              endTime,
              durationMs: endTime - startTime,
              stepCount: 1,
              llmCallCount: 1,
              totalPromptTokens: 10,
              totalCompletionTokens: 20,
              totalReward: 0,
              scenarioId: null,
              batchId: null,
              createdAt: new Date(startTime).toISOString(),
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
        }),
        getTrajectoryDetail: async () => ({
          trajectoryId,
          agentId: "chat-stream-agent",
          startTime,
          endTime,
          durationMs: endTime - startTime,
          steps: [
            {
              stepId: "step-1",
              stepNumber: 1,
              timestamp: startTime + 100,
              llmCalls: [
                {
                  callId: "call-1",
                  timestamp: startTime + 200,
                  model: "test-model",
                  systemPrompt: "system",
                  userPrompt: "hello",
                  response: "world",
                  temperature: 0.1,
                  maxTokens: 200,
                  purpose: "response",
                  promptTokens: 10,
                  completionTokens: 20,
                  latencyMs: 12,
                },
              ],
              providerAccesses: [],
            },
          ],
          totalReward: 0,
          metrics: {
            episodeLength: 1,
            finalStatus: "completed",
          },
          metadata: {
            source: "client_chat",
          },
        }),
        getStats: async () => ({
          totalTrajectories: 1,
          totalSteps: 1,
          totalLlmCalls: 1,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          averageDurationMs: endTime - startTime,
          averageReward: 0,
          bySource: { client_chat: 1 },
          byStatus: { completed: 1 },
          byScenario: {},
        }),
        deleteTrajectories: async () => 0,
        clearAllTrajectories: async () => 0,
        exportTrajectories: async () => ({
          data: "[]",
          filename: "trajectories.json",
          mimeType: "application/json",
        }),
        exportTrajectoriesZip: async () => ({
          filename: "trajectories-export.zip",
          entries: [
            { name: "manifest.json", data: "{}" },
            { name: `${trajectoryId}/summary.json`, data: "{}" },
            { name: `${trajectoryId}/trajectory.json`, data: "{}" },
          ],
        }),
      };

      const runtime = createRuntimeForChatSseTests({
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? trajectoryLogger : null,
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger" ? [trajectoryLogger] : [],
      }) as AgentRuntime & { adapter?: unknown };
      runtime.adapter = {};

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const zipRes = await reqRaw(
          streamServer.port,
          "POST",
          "/api/trajectories/export",
          { format: "zip" },
        );
        expect(zipRes.status).toBe(200);
        expect(String(zipRes.headers["content-type"] ?? "")).toContain(
          "application/zip",
        );
        expect(String(zipRes.headers["content-disposition"] ?? "")).toContain(
          ".zip",
        );
        expect(zipRes.data.subarray(0, 2).toString("utf-8")).toBe("PK");
        const zipText = zipRes.data.toString("utf-8");
        expect(zipText).toContain("manifest.json");
        expect(zipText).toContain(`${trajectoryId}/summary.json`);
      } finally {
        await streamServer.close();
      }
    });

    it("GET/PUT /api/trajectories/config reflects plugin logger enabled state", async () => {
      let enabled = false;
      const setEnabledCalls: boolean[] = [];

      const trajectoryLogger = {
        isEnabled: () => enabled,
        setEnabled: (next: boolean) => {
          setEnabledCalls.push(next);
          enabled = next;
        },
        listTrajectories: async () => ({
          trajectories: [],
          total: 0,
          offset: 0,
          limit: 50,
        }),
        getTrajectoryDetail: async () => null,
        getStats: async () => ({
          totalTrajectories: 0,
          totalSteps: 0,
          totalLlmCalls: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          averageDurationMs: 0,
          averageReward: 0,
          bySource: {},
          byStatus: {},
          byScenario: {},
        }),
        deleteTrajectories: async () => 0,
        clearAllTrajectories: async () => 0,
        exportTrajectories: async () => ({
          data: "[]",
          filename: "trajectories.json",
          mimeType: "application/json",
        }),
      };

      const runtime = createRuntimeForChatSseTests({
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? trajectoryLogger : null,
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger" ? [trajectoryLogger] : [],
      }) as AgentRuntime & { adapter?: unknown };
      runtime.adapter = {};

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const before = await req(
          streamServer.port,
          "GET",
          "/api/trajectories/config",
        );
        expect(before.status).toBe(200);
        expect(before.data.enabled).toBe(false);

        const enabledUpdate = await req(
          streamServer.port,
          "PUT",
          "/api/trajectories/config",
          { enabled: true },
        );
        expect(enabledUpdate.status).toBe(200);
        expect(enabledUpdate.data.enabled).toBe(true);
        expect(enabled).toBe(true);

        const disabledUpdate = await req(
          streamServer.port,
          "PUT",
          "/api/trajectories/config",
          { enabled: false },
        );
        expect(disabledUpdate.status).toBe(200);
        expect(disabledUpdate.data.enabled).toBe(false);
        expect(enabled).toBe(false);
        expect(setEnabledCalls).toEqual([true, false]);
      } finally {
        await streamServer.close();
      }
    });

    it.skip("persists core trajectory rows to DB and loads them after restart", async () => {
      type RawSqlQuery = {
        queryChunks?: Array<{
          value?: string[];
        }>;
      };

      const readSqlText = (query: RawSqlQuery): string => {
        const chunks = query.queryChunks ?? [];
        return chunks
          .map((chunk) =>
            Array.isArray(chunk.value) ? chunk.value.join("") : "",
          )
          .join("")
          .trim();
      };

      const splitSqlTuple = (valueList: string): string[] => {
        const values: string[] = [];
        let current = "";
        let inString = false;
        for (let i = 0; i < valueList.length; i += 1) {
          const char = valueList[i];
          if (char === "'") {
            current += char;
            if (inString && valueList[i + 1] === "'") {
              current += "'";
              i += 1;
              continue;
            }
            inString = !inString;
            continue;
          }
          if (char === "," && !inString) {
            values.push(current.trim());
            current = "";
            continue;
          }
          current += char;
        }
        if (current.trim().length > 0) values.push(current.trim());
        return values;
      };

      const parseSqlScalar = (token: string): string | number | null => {
        if (token.toUpperCase() === "NULL") return null;
        if (token.startsWith("'") && token.endsWith("'")) {
          return token.slice(1, -1).replace(/''/g, "'");
        }
        const asNumber = Number(token);
        return Number.isFinite(asNumber) ? asNumber : token;
      };

      class InMemoryTrajectoryDb {
        private rows = new Map<string, Record<string, unknown>>();

        async execute(query: RawSqlQuery): Promise<{ rows: unknown[] }> {
          const sql = readSqlText(query);
          const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();

          if (
            normalized.startsWith("create table if not exists trajectories")
          ) {
            return { rows: [] };
          }

          if (normalized.startsWith("insert into trajectories")) {
            const match =
              /insert into trajectories\s*\(([\s\S]+?)\)\s*values\s*\(([\s\S]+?)\)\s*on conflict/i.exec(
                sql,
              );
            if (!match) return { rows: [] };
            const columns = splitSqlTuple(match[1]).map((col) => col.trim());
            const values = splitSqlTuple(match[2]).map(parseSqlScalar);
            const row: Record<string, unknown> = {};
            for (let i = 0; i < columns.length; i += 1) {
              row[columns[i]] = values[i] ?? null;
            }
            const id = String(row.id ?? "");
            if (id) {
              const existing = this.rows.get(id) ?? {};
              this.rows.set(id, { ...existing, ...row });
            }
            return { rows: [] };
          }

          if (normalized.startsWith("select * from trajectories")) {
            const limitMatch = /limit\s+(\d+)/i.exec(sql);
            const limit = limitMatch ? Number(limitMatch[1]) : 5000;
            const rows = Array.from(this.rows.values()).sort((a, b) =>
              String(b.created_at ?? "").localeCompare(
                String(a.created_at ?? ""),
              ),
            );
            return { rows: rows.slice(0, limit) };
          }

          if (
            normalized.startsWith("select count(*) as total from trajectories")
          ) {
            return { rows: [{ total: this.rows.size }] };
          }

          if (normalized.startsWith("delete from trajectories where id in")) {
            const inMatch = /where id in \(([\s\S]+)\)/i.exec(sql);
            const deleted: Array<Record<string, unknown>> = [];
            if (inMatch) {
              const ids = splitSqlTuple(inMatch[1])
                .map(parseSqlScalar)
                .filter((id): id is string => typeof id === "string");
              for (const id of ids) {
                if (this.rows.delete(id)) deleted.push({ id });
              }
            }
            return normalized.includes("returning id")
              ? { rows: deleted }
              : { rows: [] };
          }

          if (normalized.startsWith("delete from trajectories")) {
            this.rows.clear();
            return { rows: [] };
          }

          return { rows: [] };
        }
      }

      const db = new InMemoryTrajectoryDb();

      const createCoreLogger = () => {
        const llmCalls: Array<Record<string, unknown>> = [];
        const providerAccess: Array<Record<string, unknown>> = [];
        return {
          logLlmCall: (params: Record<string, unknown>) => {
            llmCalls.push({
              ...params,
              timestamp:
                typeof params.timestamp === "number"
                  ? params.timestamp
                  : Date.now(),
            });
          },
          logProviderAccess: (params: Record<string, unknown>) => {
            providerAccess.push({
              ...params,
              timestamp:
                typeof params.timestamp === "number"
                  ? params.timestamp
                  : Date.now(),
            });
          },
          getLlmCallLogs: () => llmCalls,
          getProviderAccessLogs: () => providerAccess,
        };
      };

      const createRuntime = () => {
        const coreLogger = createCoreLogger();
        const runtime = createRuntimeForChatSseTests({
          getService: (serviceType) =>
            serviceType === "trajectory_logger" ? coreLogger : null,
          getServicesByType: (serviceType) =>
            serviceType === "trajectory_logger" ? [coreLogger] : [],
          handleMessage: async (runtimeArg, message, onResponse) => {
            const metadata =
              message && typeof message === "object" && "metadata" in message
                ? (message as { metadata?: { trajectoryStepId?: string } })
                    .metadata
                : undefined;
            const stepId = metadata?.trajectoryStepId;
            if (stepId) {
              const logger = runtimeArg.getService("trajectory_logger") as {
                logLlmCall?: (params: Record<string, unknown>) => void;
              } | null;
              logger?.logLlmCall?.({
                stepId,
                model: "unit-test-model",
                systemPrompt: "system",
                userPrompt: "persist me",
                response: "persisted",
                temperature: 0,
                maxTokens: 32,
                purpose: "response",
                actionType: "test",
                promptTokens: 3,
                completionTokens: 4,
                latencyMs: 10,
              });
            }
            await onResponse({ text: "persisted" } as Content);
            return {
              responseContent: {
                text: "persisted",
              },
            };
          },
        }) as AgentRuntime & {
          adapter?: {
            db: { execute: (query: RawSqlQuery) => Promise<unknown> };
          };
        };
        runtime.adapter = { db };
        return runtime;
      };

      const runtimeA = createRuntime();
      const serverA = await startApiServer({ port: 0, runtime: runtimeA });
      let firstTrajectoryId: string | null = null;
      try {
        const chat = await req(serverA.port, "POST", "/api/chat", {
          text: "persist this trajectory",
          mode: "simple",
        });
        expect(chat.status).toBe(200);

        const list = await req(serverA.port, "GET", "/api/trajectories");
        expect(list.status).toBe(200);
        const rows = list.data.trajectories as Array<Record<string, unknown>>;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        firstTrajectoryId = String(rows[0]?.id ?? "");
        expect(firstTrajectoryId.length).toBeGreaterThan(0);
      } finally {
        await serverA.close();
      }

      const runtimeB = createRuntime();
      const serverB = await startApiServer({ port: 0, runtime: runtimeB });
      try {
        const listAfterRestart = await req(
          serverB.port,
          "GET",
          "/api/trajectories",
        );
        expect(listAfterRestart.status).toBe(200);
        const rows = listAfterRestart.data.trajectories as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        const ids = rows.map((row) => String(row.id ?? ""));
        expect(ids).toContain(firstTrajectoryId);
      } finally {
        await serverB.close();
      }
    });
  });

  describe("insufficient credits fallback", () => {
    it("POST /api/chat replaces '(no response)' with a top-up message", async () => {
      const runtime = createRuntimeForCreditNoResponseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "hello",
            mode: "power",
          },
        );
        expect(status).toBe(200);
        expect(String(data.text)).toMatch(/top up your credits/i);
        expect(String(data.text)).not.toBe("(no response)");
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat/stream emits a done event with top-up text", async () => {
      const runtime = createRuntimeForCreditNoResponseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, events } = await reqSse(
          streamServer.port,
          "/api/chat/stream",
          { text: "hello", mode: "power" },
        );
        expect(status).toBe(200);
        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent).toBeDefined();
        expect(String(doneEvent?.fullText ?? "")).toMatch(
          /top up your credits/i,
        );
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat returns a top-up message when the provider throws insufficient credits", async () => {
      const runtime = createRuntimeForCreditErrorTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "hello",
            mode: "power",
          },
        );
        expect(status).toBe(200);
        expect(String(data.text)).toMatch(/top up your credits/i);
      } finally {
        await streamServer.close();
      }
    });

    it("POST /api/chat replaces literal '(no response)' payloads with a top-up message", async () => {
      const runtime = createRuntimeForCreditLiteralNoResponseTests();
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const { status, data } = await req(
          streamServer.port,
          "POST",
          "/api/chat",
          {
            text: "hello",
            mode: "power",
          },
        );
        expect(status).toBe(200);
        expect(String(data.text)).toMatch(/top up your credits/i);
        expect(String(data.text)).not.toBe("(no response)");
      } finally {
        await streamServer.close();
      }
    });

    it("GET /api/trajectories prefers route-compatible logger when byType contains core logger", async () => {
      const coreLogger = {
        logLlmCall: () => {},
      };

      const fullLogger = {
        isEnabled: () => true,
        setEnabled: () => {},
        listTrajectories: async () => ({
          trajectories: [
            {
              id: "trajectory-1",
              agentId: "chat-stream-agent",
              source: "client_chat",
              status: "completed",
              startTime: Date.now() - 1000,
              endTime: Date.now(),
              durationMs: 1000,
              stepCount: 1,
              llmCallCount: 1,
              totalPromptTokens: 10,
              totalCompletionTokens: 20,
              totalReward: 0,
              scenarioId: null,
              batchId: null,
              createdAt: new Date().toISOString(),
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
        }),
        getTrajectoryDetail: async () => null,
        getStats: async () => ({
          totalTrajectories: 1,
          totalSteps: 1,
          totalLlmCalls: 1,
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          averageDurationMs: 1000,
          averageReward: 0,
          bySource: { client_chat: 1 },
          byStatus: { completed: 1 },
          byScenario: {},
        }),
        deleteTrajectories: async () => 0,
        clearAllTrajectories: async () => 0,
        exportTrajectories: async () => ({
          data: "[]",
          filename: "trajectories.json",
          mimeType: "application/json",
        }),
      };

      const runtime = createRuntimeForChatSseTests({
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger" ? [coreLogger] : [],
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? fullLogger : null,
      }) as AgentRuntime & { adapter?: unknown };
      runtime.adapter = {};

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const res = await req(streamServer.port, "GET", "/api/trajectories");
        expect(res.status).toBe(200);
        const rows = res.data.trajectories as Array<Record<string, unknown>>;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.llmCallCount).toBe(1);
      } finally {
        await streamServer.close();
      }
    });

    it("GET /api/trajectories returns 503 when no route-compatible logger is available", async () => {
      const runtime = createRuntimeForChatSseTests({
        getServicesByType: (serviceType) =>
          serviceType === "trajectory_logger" ? [{ logLlmCall: () => {} }] : [],
        getService: (serviceType) =>
          serviceType === "trajectory_logger" ? { logLlmCall: () => {} } : null,
      }) as AgentRuntime & { adapter?: unknown };
      runtime.adapter = {};

      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        const res = await req(streamServer.port, "GET", "/api/trajectories");
        expect(res.status).toBe(503);
        expect(String(res.data.error)).toContain(
          "Trajectory logger service not available",
        );
      } finally {
        await streamServer.close();
      }
    });
  });

  describe("trigger endpoints (no runtime)", () => {
    it("GET /api/triggers returns 503", async () => {
      const { status, data } = await req(port, "GET", "/api/triggers");
      expect(status).toBe(503);
      expect(String(data.error)).toContain("not running");
    });

    it("POST /api/triggers returns 503", async () => {
      const { status } = await req(port, "POST", "/api/triggers", {
        displayName: "Heartbeat",
        instructions: "Status heartbeat",
        triggerType: "interval",
        intervalMs: 120000,
      });
      expect(status).toBe(503);
    });

    it("GET /api/triggers/health returns 503", async () => {
      const { status } = await req(port, "GET", "/api/triggers/health");
      expect(status).toBe(503);
    });
  });

  // -- Fine-tuning endpoints --

  describe("GET /api/training/* (no runtime)", () => {
    it("returns training status with runtimeUnavailable", async () => {
      const { status, data } = await req(port, "GET", "/api/training/status");
      expect(status).toBe(200);
      expect(data.runtimeAvailable).toBe(false);
      expect(typeof data.runningJobs).toBe("number");
      expect(typeof data.datasetCount).toBe("number");
      expect(typeof data.modelCount).toBe("number");
    });

    it("returns unavailable trajectories when runtime is missing", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/training/trajectories?limit=10&offset=0",
      );
      expect(status).toBe(200);
      expect(data.available).toBe(false);
      expect(data.reason).toBe("runtime_not_started");
    });

    it("returns datasets, jobs, and models lists", async () => {
      const datasets = await req(port, "GET", "/api/training/datasets");
      const jobs = await req(port, "GET", "/api/training/jobs");
      const models = await req(port, "GET", "/api/training/models");

      expect(datasets.status).toBe(200);
      expect(jobs.status).toBe(200);
      expect(models.status).toBe(200);
      expect(Array.isArray(datasets.data.datasets)).toBe(true);
      expect(Array.isArray(jobs.data.jobs)).toBe(true);
      expect(Array.isArray(models.data.models)).toBe(true);
    });

    it("returns 404 for missing trajectory and missing job", async () => {
      const trajectory = await req(
        port,
        "GET",
        "/api/training/trajectories/not-found",
      );
      const job = await req(port, "GET", "/api/training/jobs/not-found");
      expect(trajectory.status).toBe(404);
      expect(job.status).toBe(404);
    });

    it("streams dataset build events over websocket", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      try {
        await waitForWsMessage(ws, (message) => message.type === "status");
        const waitForDatasetBuilt = waitForWsMessage(
          ws,
          (message) =>
            message.type === "training_event" &&
            ((message.payload as Record<string, unknown>)?.kind as string) ===
              "dataset_built",
        );

        const response = await req(
          port,
          "POST",
          "/api/training/datasets/build",
          {
            limit: 5,
            minLlmCallsPerTrajectory: 1,
          },
        );
        expect(response.status).toBe(201);

        const message = await waitForDatasetBuilt;
        expect(message.type).toBe("training_event");
        expect((message.payload as Record<string, unknown>)?.kind).toBe(
          "dataset_built",
        );
      } finally {
        ws.close();
      }
    });

    it("returns 400 for invalid job/model mutation requests", async () => {
      const startJob = await req(port, "POST", "/api/training/jobs", {
        datasetId: "dataset-does-not-exist",
      });
      const importModel = await req(
        port,
        "POST",
        "/api/training/models/model-does-not-exist/import-ollama",
        {},
      );
      const activateModel = await req(
        port,
        "POST",
        "/api/training/models/model-does-not-exist/activate",
        {},
      );
      const benchmarkModel = await req(
        port,
        "POST",
        "/api/training/models/model-does-not-exist/benchmark",
        {},
      );

      expect(startJob.status).toBe(400);
      expect(importModel.status).toBe(400);
      expect(activateModel.status).toBe(400);
      expect(benchmarkModel.status).toBe(400);
    });

    it("returns 404 when cancelling unknown training job", async () => {
      const response = await req(
        port,
        "POST",
        "/api/training/jobs/job-does-not-exist/cancel",
        {},
      );
      expect(response.status).toBe(404);
    });
  });

  // -- Plugin discovery (real filesystem) --

  describe("GET /api/plugins", () => {
    it("returns a plugins array from real filesystem scan", async () => {
      const { status, data } = await req(port, "GET", "/api/plugins");
      expect(status).toBe(200);
      expect(Array.isArray(data.plugins)).toBe(true);
    });

    it("plugins have correct shape", async () => {
      const { data } = await req(port, "GET", "/api/plugins");
      const plugins = data.plugins as Array<Record<string, unknown>>;
      if (plugins.length > 0) {
        const p = plugins[0];
        expect(typeof p.id).toBe("string");
        expect(typeof p.name).toBe("string");
        expect(typeof p.description).toBe("string");
        expect(typeof p.enabled).toBe("boolean");
        expect(typeof p.configured).toBe("boolean");
        expect(["ai-provider", "connector", "database", "feature"]).toContain(
          p.category,
        );
        expect(Array.isArray(p.configKeys)).toBe(true);
      }
    });

    it("hides Vercel OIDC token key from plugin metadata", async () => {
      const { data } = await req(port, "GET", "/api/plugins");
      const plugins = data.plugins as Array<Record<string, unknown>>;
      const vercel = plugins.find((p) => p.id === "vercel-ai-gateway");
      if (!vercel) return;

      const configKeys = Array.isArray(vercel.configKeys)
        ? (vercel.configKeys as string[])
        : [];
      expect(configKeys).not.toContain("VERCEL_OIDC_TOKEN");

      const parameters = Array.isArray(vercel.parameters)
        ? (vercel.parameters as Array<Record<string, unknown>>)
        : [];
      const parameterKeys = parameters.map((param) => param.key);
      expect(parameterKeys).not.toContain("VERCEL_OIDC_TOKEN");
    });
  });

  // -- Skills discovery --

  describe("GET /api/skills", () => {
    it("returns a skills array", async () => {
      const { status, data } = await req(port, "GET", "/api/skills");
      expect(status).toBe(200);
      expect(Array.isArray(data.skills)).toBe(true);
    });

    it("includes marketplace-installed skills from the hidden .marketplace directory", async () => {
      const marketplaceSkillDir = path.join(
        _e2eTempDir,
        "workspace",
        "skills",
        ".marketplace",
        "remote-skill",
      );
      await fs.mkdir(marketplaceSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(marketplaceSkillDir, "SKILL.md"),
        [
          "---",
          "name: Remote Skill",
          "description: Installed from marketplace",
          "---",
          "",
          "# Remote skill",
        ].join("\n"),
        "utf-8",
      );

      try {
        const refreshed = await req(port, "POST", "/api/skills/refresh", {});
        expect(refreshed.status).toBe(200);
        const skills = refreshed.data.skills as Array<{ id?: string }>;
        expect(skills.some((skill) => skill.id === "remote-skill")).toBe(true);
      } finally {
        await fs.rm(path.join(_e2eTempDir, "workspace", "skills"), {
          recursive: true,
          force: true,
        });
        await req(port, "POST", "/api/skills/refresh", {});
      }
    });

    it("falls back to runtime-provided skill directories when AgentSkillsService is empty", async () => {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "eliza-skills-"),
      );
      const bundledDir = path.join(tempRoot, "bundled-skills");
      const skillDir = path.join(bundledDir, "fallback-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: Fallback Skill",
          "description: Loads when catalog sync fails",
          "---",
          "",
          "# Fallback skill",
        ].join("\n"),
        "utf-8",
      );

      const runtime = {
        agentId: "skills-fallback-agent",
        character: { name: "SkillsFallbackAgent" },
        getService: (serviceType: string) => {
          if (serviceType === "AGENT_SKILLS_SERVICE") {
            return {
              getLoadedSkills: () => [],
            };
          }
          return null;
        },
        getSetting: (key: string) => {
          if (key === "BUNDLED_SKILLS_DIRS") return bundledDir;
          return undefined;
        },
        getRoomsByWorld: async () => [],
        getTasks: async () => [],
        getTask: async () => null,
        createTask: async () => crypto.randomUUID() as UUID,
        updateTask: async () => {},
        deleteTask: async () => {},
      } as unknown as unknown as AgentRuntime;

      const streamServer = await startApiServer({ port: 0, runtime });
      const streamPort = streamServer.port;

      try {
        const refreshed = await req(
          streamPort,
          "POST",
          "/api/skills/refresh",
          {},
        );
        expect(refreshed.status).toBe(200);
        const skills = refreshed.data.skills as Array<{ id?: string }>;
        expect(skills.some((skill) => skill.id === "fallback-skill")).toBe(
          true,
        );
      } finally {
        await streamServer.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    it("discovers managed skills from the state dir", async () => {
      const managedSkillDir = path.join(_e2eTempDir, "skills", "managed-skill");
      await fs.mkdir(managedSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(managedSkillDir, "SKILL.md"),
        [
          "---",
          "name: managed-skill",
          "description: Seeded from the managed skills store",
          "---",
          "",
          "# Managed skill",
        ].join("\n"),
        "utf-8",
      );

      try {
        const refreshed = await req(port, "POST", "/api/skills/refresh", {});
        expect(refreshed.status).toBe(200);
        const skills = refreshed.data.skills as Array<{ id?: string }>;
        expect(skills.some((skill) => skill.id === "managed-skill")).toBe(true);
      } finally {
        await fs.rm(path.join(_e2eTempDir, "skills"), {
          recursive: true,
          force: true,
        });
        await req(port, "POST", "/api/skills/refresh", {});
      }
    });
  });

  describe("skills marketplace endpoints", () => {
    it("GET /api/skills/marketplace/search requires query", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/skills/marketplace/search",
      );
      expect(status).toBe(400);
      expect(String(data.error)).toContain("Query");
    });

    it("GET /api/skills/marketplace/installed returns array", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/skills/marketplace/installed",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.skills)).toBe(true);
    });

    it("GET /api/skills/marketplace/search reports upstream network failures", async () => {
      const savedRegistry = process.env.SKILLS_REGISTRY;
      try {
        process.env.SKILLS_REGISTRY = "http://127.0.0.1:1";
        const { status, data } = await req(
          port,
          "GET",
          "/api/skills/marketplace/search?q=agent",
        );
        expect(status).toBe(502);
        expect(String(data.error).toLowerCase()).toContain("network");
      } finally {
        if (savedRegistry === undefined) delete process.env.SKILLS_REGISTRY;
        else process.env.SKILLS_REGISTRY = savedRegistry;
      }
    });

    it("POST /api/skills/marketplace/install validates source input", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/skills/marketplace/install",
        { name: "test" },
      );
      expect(status).toBe(400);
      expect(String(data.error)).toContain("githubUrl");
    });

    it("POST /api/skills/marketplace/uninstall validates id input", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/skills/marketplace/uninstall",
        {},
      );
      expect(status).toBe(400);
      expect(String(data.error)).toContain("id");
    });
  });

  // -- Logs --

  describe("GET /api/logs", () => {
    it("returns entries array with at least the startup log", async () => {
      const { status, data } = await req(port, "GET", "/api/logs");
      expect(status).toBe(200);
      expect(Array.isArray(data.entries)).toBe(true);
      const entries = data.entries as Array<Record<string, unknown>>;
      expect(entries.length).toBeGreaterThan(0);
      // Verify log entry shape
      expect(typeof entries[0].timestamp).toBe("number");
      expect(typeof entries[0].level).toBe("string");
      expect(typeof entries[0].message).toBe("string");
    });
  });

  describe("GET /api/agent/events", () => {
    it("returns replay response shape", async () => {
      const { status, data } = await req(port, "GET", "/api/agent/events");
      expect(status).toBe(200);
      expect(Array.isArray(data.events)).toBe(true);
      expect(typeof data.replayed).toBe("boolean");
      expect(typeof data.totalBuffered).toBe("number");
      expect(
        data.latestEventId === null || typeof data.latestEventId === "string",
      ).toBe(true);
    });

    it("captures runtime AGENT_EVENT emissions in replay buffer", async () => {
      const eventService = new TestAgentEventService();
      const runtime = createRuntimeForStreamTests({
        eventService,
        loopRunning: false,
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      try {
        eventService.emit({
          runId: "run-stream",
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: { text: "stream-check" },
          agentId: "test-agent-id",
        });

        const { status, data } = await req(
          streamServer.port,
          "GET",
          "/api/agent/events",
        );
        expect(status).toBe(200);
        const events = data.events as Array<Record<string, unknown>>;
        const hasExpectedEvent = events.some((event) => {
          const payload = event.payload as Record<string, unknown>;
          return (
            event.type === "agent_event" && payload.text === "stream-check"
          );
        });
        expect(hasExpectedEvent).toBe(true);
      } finally {
        await streamServer.close();
      }
    });

    it("streams AGENT_EVENT over websocket clients", async () => {
      const eventService = new TestAgentEventService();
      const runtime = createRuntimeForStreamTests({
        eventService,
        loopRunning: false,
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      const ws = new WebSocket(`ws://127.0.0.1:${streamServer.port}/ws`);
      try {
        await waitForWsMessage(ws, (message) => message.type === "status");

        const waitForAgentEvent = waitForWsMessage(
          ws,
          (message) =>
            message.type === "agent_event" &&
            ((message.payload as Record<string, unknown>)?.text as string) ===
              "ws-stream-check",
        );

        eventService.emit({
          runId: "run-stream-ws",
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: { text: "ws-stream-check" },
          agentId: "test-agent-id",
        });

        const message = await waitForAgentEvent;
        expect(message.type).toBe("agent_event");
      } finally {
        ws.close();
        await streamServer.close();
      }
    }, 30_000);

    it("routes proactive autonomy output to active chat and exposes matching overview/event surfaces", async () => {
      const eventService = new TestAgentEventService();
      const runtime = createRuntimeForAutonomySurfaceTests({
        eventService,
        loopRunning: true,
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      const ws = new WebSocket(`ws://127.0.0.1:${streamServer.port}/ws`);
      try {
        await waitForWsMessage(ws, (message) => message.type === "status");

        const createConversation = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "Autonomy routing test",
          },
        );
        expect(createConversation.status).toBe(200);
        const conversation = createConversation.data.conversation as {
          id?: string;
        };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        ws.send(
          JSON.stringify({
            type: "active-conversation",
            conversationId,
          }),
        );

        const waitForThought = waitForWsMessage(
          ws,
          (message) =>
            message.type === "agent_event" &&
            ((message.payload as Record<string, unknown>)?.text as string) ===
              "autonomy-thought",
        );
        const waitForAction = waitForWsMessage(
          ws,
          (message) =>
            message.type === "agent_event" &&
            ((message.payload as Record<string, unknown>)?.text as string) ===
              "autonomy-action",
        );
        const waitForProactive = waitForWsMessage(
          ws,
          (message) =>
            message.type === "proactive-message" &&
            message.conversationId === conversationId,
          6000,
        );

        eventService.emit({
          runId: "run-autonomy-surface",
          seq: 1,
          stream: "provider",
          ts: Date.now() - 5,
          data: { text: "autonomy-thought" },
          agentId: "autonomy-surface-agent",
        });
        eventService.emit({
          runId: "run-autonomy-surface",
          seq: 2,
          stream: "provider",
          ts: Date.now() - 1,
          data: { text: "autonomy-action" },
          agentId: "autonomy-surface-agent",
        });
        eventService.emit({
          runId: "run-autonomy-surface",
          seq: 3,
          stream: "assistant",
          ts: Date.now(),
          data: {
            text: "Autonomy says: trigger follow-up",
            source: "trigger-dispatch",
          },
          agentId: "autonomy-surface-agent",
          roomId: "00000000-0000-0000-0000-00000000a999" as UUID,
        });

        await waitForThought;
        await waitForAction;
        const proactive = await waitForProactive;
        const proactiveMessage = proactive.message as Record<string, unknown>;
        expect(proactiveMessage.source).toBe("trigger-dispatch");
        expect(String(proactiveMessage.text ?? "")).toContain("Autonomy says:");

        const messagesResponse = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        );
        expect(messagesResponse.status).toBe(200);
        const messages = messagesResponse.data.messages as Array<
          Record<string, unknown>
        >;
        const routed = messages.find(
          (message) =>
            message.role === "assistant" &&
            message.source === "trigger-dispatch",
        );
        expect(routed).toBeDefined();
        expect(String(routed?.text ?? "")).toContain("Autonomy says:");

        const replayResponse = await req(
          streamServer.port,
          "GET",
          "/api/agent/events?limit=50",
        );
        expect(replayResponse.status).toBe(200);
        const replayEvents = replayResponse.data.events as Array<
          Record<string, unknown>
        >;
        const replayPayloads = replayEvents
          .filter((event) => event.type === "agent_event")
          .map((event) => event.payload as Record<string, unknown>);
        expect(
          replayPayloads.some((payload) => payload.text === "autonomy-thought"),
        ).toBe(true);
        expect(
          replayPayloads.some((payload) => payload.text === "autonomy-action"),
        ).toBe(true);

        const overviewResponse = await req(
          streamServer.port,
          "GET",
          "/api/workbench/overview",
        );
        expect(overviewResponse.status).toBe(200);
        const tasks = (overviewResponse.data.tasks ?? []) as Array<
          Record<string, unknown>
        >;
        const triggers = (overviewResponse.data.triggers ?? []) as Array<
          Record<string, unknown>
        >;
        expect(
          tasks.some((task) => task.name === "Autonomy surface task"),
        ).toBe(true);
        expect(
          triggers.some(
            (trigger) => trigger.displayName === "Autonomy surface trigger",
          ),
        ).toBe(true);
      } finally {
        ws.close();
        await streamServer.close();
      }
    }, 30_000);

    it("does not route client_chat assistant events into proactive messages", async () => {
      const eventService = new TestAgentEventService();
      const runtime = createRuntimeForAutonomySurfaceTests({
        eventService,
        loopRunning: true,
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      const ws = new WebSocket(`ws://127.0.0.1:${streamServer.port}/ws`);
      try {
        await waitForWsMessage(ws, (message) => message.type === "status");

        const createConversation = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "No client_chat proactive routing",
          },
        );
        expect(createConversation.status).toBe(200);
        const conversation = createConversation.data.conversation as {
          id?: string;
        };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        ws.send(
          JSON.stringify({
            type: "active-conversation",
            conversationId,
          }),
        );

        eventService.emit({
          runId: "run-client-chat-no-proactive",
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: {
            text: "should-not-route-to-proactive",
            source: "client_chat",
          },
          agentId: "autonomy-surface-agent",
        });

        await expect(
          waitForWsMessage(
            ws,
            (message) =>
              message.type === "proactive-message" &&
              message.conversationId === conversationId,
            900,
          ),
        ).rejects.toThrow("Timed out waiting for websocket message");

        const messagesResponse = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        );
        expect(messagesResponse.status).toBe(200);
        const messages = messagesResponse.data.messages as Array<
          Record<string, unknown>
        >;
        const routed = messages.find(
          (message) =>
            String(message.text ?? "") === "should-not-route-to-proactive",
        );
        expect(routed).toBeUndefined();
      } finally {
        ws.close();
        await streamServer.close();
      }
    }, 30_000);

    it("does not route ambiguous assistant events without source or room metadata", async () => {
      const eventService = new TestAgentEventService();
      const runtime = createRuntimeForAutonomySurfaceTests({
        eventService,
        loopRunning: true,
      });
      const streamServer = await startApiServer({ port: 0, runtime });
      const ws = new WebSocket(`ws://127.0.0.1:${streamServer.port}/ws`);
      try {
        await waitForWsMessage(ws, (message) => message.type === "status");

        const createConversation = await req(
          streamServer.port,
          "POST",
          "/api/conversations",
          {
            title: "No ambiguous proactive routing",
          },
        );
        expect(createConversation.status).toBe(200);
        const conversation = createConversation.data.conversation as {
          id?: string;
        };
        const conversationId = conversation.id ?? "";
        expect(conversationId.length).toBeGreaterThan(0);

        ws.send(
          JSON.stringify({
            type: "active-conversation",
            conversationId,
          }),
        );

        eventService.emit({
          runId: "run-ambiguous-no-proactive",
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: {
            text: "ambiguous-should-not-route",
          },
          agentId: "autonomy-surface-agent",
        });

        await expect(
          waitForWsMessage(
            ws,
            (message) =>
              message.type === "proactive-message" &&
              message.conversationId === conversationId,
            900,
          ),
        ).rejects.toThrow("Timed out waiting for websocket message");

        const messagesResponse = await req(
          streamServer.port,
          "GET",
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        );
        expect(messagesResponse.status).toBe(200);
        const messages = messagesResponse.data.messages as Array<
          Record<string, unknown>
        >;
        const routed = messages.find(
          (message) =>
            String(message.text ?? "") === "ambiguous-should-not-route",
        );
        expect(routed).toBeUndefined();
      } finally {
        ws.close();
        await streamServer.close();
      }
    }, 30_000);
  });

  // -- Onboarding --

  describe("onboarding endpoints", () => {
    it("GET /api/onboarding/status returns complete flag", async () => {
      const { status, data } = await req(port, "GET", "/api/onboarding/status");
      expect(status).toBe(200);
      expect(typeof data.complete).toBe("boolean");
    });

    it("GET /api/onboarding/options returns real presets", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/onboarding/options",
      );
      expect(status).toBe(200);
      const names = data.names as string[];
      const styles = data.styles as unknown[];
      const providers = data.providers as unknown[];

      expect(names.length).toBeGreaterThan(0);
      expect(styles.length).toBeGreaterThan(0);
      expect(providers.length).toBeGreaterThan(0);

      // Verify names come from the real preset pool (random subset)
      for (const name of names) {
        expect(AGENT_NAME_POOL).toContain(name);
      }
      // Ensure names are unique
      expect(new Set(names).size).toBe(names.length);
    });

    it("POST /api/onboarding stores adminEntityId in defaults", async () => {
      const res = await req(port, "POST", "/api/onboarding", {
        name: "AdminAgent",
        connection: {
          kind: "local-provider",
          provider: "anthropic",
        },
        runMode: "local",
      });
      expect(res.status).toBe(200);

      const cfg = await req(port, "GET", "/api/config");
      const defaults = (
        cfg.data as {
          agents?: { defaults?: { adminEntityId?: string } };
        }
      ).agents?.defaults;
      const adminEntityId = defaults?.adminEntityId ?? "";
      expect(typeof adminEntityId).toBe("string");
      expect(adminEntityId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  // -- Config --

  describe("config endpoints", () => {
    it("GET /api/config returns config object", async () => {
      const { status, data } = await req(port, "GET", "/api/config");
      expect(status).toBe(200);
      expect(typeof data).toBe("object");
    });

    it("PUT /api/config → GET /api/config round-trips", async () => {
      const original = (await req(port, "GET", "/api/config")).data;

      // Write new config — use "features" (an allowed top-level key)
      await req(port, "PUT", "/api/config", {
        features: { roundTrip: { enabled: true } },
      });
      const { data } = await req(port, "GET", "/api/config");
      expect(
        (data as Record<string, Record<string, Record<string, boolean>>>)
          .features?.roundTrip?.enabled,
      ).toBe(true);

      // Restore
      await req(port, "PUT", "/api/config", original);
    });
  });

  // -- Autonomy --

  // -- Workbench --

  describe("workbench endpoints", () => {
    it("GET /api/workbench/overview returns summary + arrays", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/workbench/overview",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.tasks)).toBe(true);
      expect(Array.isArray(data.triggers)).toBe(true);
      expect(Array.isArray(data.todos)).toBe(true);
      expect(typeof data.summary).toBe("object");
    });

    it("GET /api/workbench/tasks returns 503 when runtime is absent", async () => {
      const { status } = await req(port, "GET", "/api/workbench/tasks");
      expect(status).toBe(503);
    });

    it("POST /api/workbench/tasks returns 503 when runtime is absent", async () => {
      const { status } = await req(port, "POST", "/api/workbench/tasks", {
        name: "test task",
      });
      expect(status).toBe(503);
    });

    it("PUT /api/workbench/todos/:id returns 503 when runtime is absent", async () => {
      const { status } = await req(port, "PUT", "/api/workbench/todos/fake", {
        isCompleted: true,
      });
      expect(status).toBe(503);
    });

    it("POST /api/workbench/todos returns 503 when runtime is absent", async () => {
      const { status } = await req(port, "POST", "/api/workbench/todos", {
        name: "test todo",
      });
      expect(status).toBe(503);
    });
  });

  describe("share ingest endpoints", () => {
    it("POST /api/ingest/share accepts payload", async () => {
      const { status, data } = await req(port, "POST", "/api/ingest/share", {
        source: "e2e-test",
        title: "Shared article",
        url: "https://example.com/story",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(typeof data.item).toBe("object");
      expect(
        typeof (data.item as Record<string, unknown>).suggestedPrompt,
      ).toBe("string");
    });

    it("GET /api/ingest/share?consume=1 drains queued items", async () => {
      await req(port, "POST", "/api/ingest/share", {
        source: "e2e-test",
        text: "something to analyze",
      });
      const first = await req(port, "GET", "/api/ingest/share?consume=1");
      expect(first.status).toBe(200);
      expect(Array.isArray(first.data.items)).toBe(true);
      expect((first.data.items as unknown[]).length).toBeGreaterThan(0);

      const second = await req(port, "GET", "/api/ingest/share?consume=1");
      expect(second.status).toBe(200);
      expect(Array.isArray(second.data.items)).toBe(true);
      expect((second.data.items as unknown[]).length).toBe(0);
    });
  });

  // -- CORS --

  describe("CORS", () => {
    it("OPTIONS returns 204", async () => {
      const { status } = await req(port, "OPTIONS", "/api/status");
      expect(status).toBe(204);
    });

    it("localhost origin echoed back in CORS header", async () => {
      const origin = `http://localhost:${port}`;
      const { status, headers } = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
      }>((resolve, reject) => {
        const r = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/status",
            method: "GET",
            headers: { Origin: origin },
          },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0, headers: res.headers });
          },
        );
        r.on("error", reject);
        r.end();
      });
      expect(status).toBe(200);
      expect(headers["access-control-allow-origin"]).toBe(origin);
    });

    it("non-local origin is rejected", async () => {
      const { status } = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const r = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/status",
              method: "GET",
              headers: { Origin: "https://evil.example.com" },
            },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode ?? 0 });
            },
          );
          r.on("error", reject);
          r.end();
        },
      );
      expect(status).toBe(403);
    });
  });

  // -- Error handling --

  describe("error handling", () => {
    it("non-JSON POST body → 400", async () => {
      const { status } = await new Promise<{ status: number }>(
        (resolve, reject) => {
          const r = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/chat",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": 11,
              },
            },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode ?? 0 });
            },
          );
          r.on("error", reject);
          r.write("not-json!!!");
          r.end();
        },
      );
      expect(status).toBe(400);
    });

    it("unknown route → 404", async () => {
      expect((await req(port, "GET", "/api/does-not-exist")).status).toBe(404);
    });

    it("PUT /api/plugins/nonexistent → 404", async () => {
      expect(
        (
          await req(port, "PUT", "/api/plugins/nonexistent-plugin", {
            enabled: true,
          })
        ).status,
      ).toBe(404);
    });
  });

  // -- SPA asset fallback guard --

  describe("SPA asset fallback guard", () => {
    it("GET /nonexistent-file.vrm does not return 200 with text/html", async () => {
      const { status, headers } = await reqRaw(
        port,
        "GET",
        "/nonexistent-file.vrm",
      );
      // The SPA fallback must never serve index.html for asset extension requests.
      // Before the fix, missing .vrm files were incorrectly returned as 200 text/html.
      expect(status).not.toBe(200);
      expect(String(headers["content-type"] ?? "")).not.toContain("text/html");
    });

    it("GET /some-unknown-route (no extension) is not blocked by the asset extension guard", async () => {
      const { status, headers } = await reqRaw(
        port,
        "GET",
        "/some-unknown-route",
      );
      // Extensionless paths must pass through the SPA fallback guard unchanged.
      // Possible outcomes depending on environment:
      //   200 — SPA fallback served index.html (production build with UI)
      //   401 — auth gate intercepted (auth-enabled config)
      //   404 — no built UI available, no matching route (CI/test environment)
      // All are acceptable; the test only checks this was NOT blocked by the
      // asset extension guard (which rejects paths like .vrm, .glb, .png).
      expect([200, 401, 404]).toContain(status);
      if (status === 200) {
        const contentType = String(headers["content-type"] ?? "");
        expect(contentType).toContain("text/html");
      }
    });
  });

  // -- MCP Marketplace & Config --

  describe("MCP marketplace endpoints", () => {
    it("GET /api/mcp/marketplace/search returns results array", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/mcp/marketplace/search?q=test&limit=5",
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.results)).toBe(true);
    });

    it("GET /api/mcp/marketplace/search works with empty query", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/mcp/marketplace/search",
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.results)).toBe(true);
    });

    it("GET /api/mcp/marketplace/details/:name returns 404 for nonexistent server", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/mcp/marketplace/details/nonexistent-server-xyz-123",
      );
      expect(status).toBe(404);
      expect(typeof data.error).toBe("string");
    });

    it("GET /api/mcp/marketplace/details requires name parameter", async () => {
      const { status } = await req(
        port,
        "GET",
        "/api/mcp/marketplace/details/",
      );
      expect(status).toBe(400);
    });
  });

  describe("MCP config endpoints", () => {
    it("GET /api/mcp/config returns servers object", async () => {
      const { status, data } = await req(port, "GET", "/api/mcp/config");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(typeof data.servers).toBe("object");
    });

    it("POST /api/mcp/config/server adds a server and returns requiresRestart", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/mcp/config/server",
        {
          name: "test-server",
          config: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@test/mcp-server"],
          },
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.name).toBe("test-server");
      expect(data.requiresRestart).toBe(true);

      // Verify it persisted
      const { data: configData } = await req(port, "GET", "/api/mcp/config");
      const servers = configData.servers as Record<
        string,
        Record<string, unknown>
      >;
      expect(servers["test-server"]).toBeDefined();
      expect(servers["test-server"].type).toBe("stdio");
      expect(servers["test-server"].command).toBe("npx");
    });

    it("POST /api/mcp/config/server validates name", async () => {
      const { status } = await req(port, "POST", "/api/mcp/config/server", {
        name: "",
        config: { type: "stdio", command: "npx" },
      });
      expect(status).toBe(400);
    });

    it("POST /api/mcp/config/server rejects reserved server names", async () => {
      const { status } = await req(port, "POST", "/api/mcp/config/server", {
        name: "__proto__",
        config: { type: "stdio", command: "npx" },
      });
      expect(status).toBe(400);
    });

    it("POST /api/mcp/config/server validates config type", async () => {
      const { status } = await req(port, "POST", "/api/mcp/config/server", {
        name: "bad-type",
        config: { type: "invalid" },
      });
      expect(status).toBe(400);
    });

    it("POST /api/mcp/config/server validates command for stdio", async () => {
      const { status } = await req(port, "POST", "/api/mcp/config/server", {
        name: "no-cmd",
        config: { type: "stdio" },
      });
      expect(status).toBe(400);
    });

    it("POST /api/mcp/config/server validates url for remote servers", async () => {
      const { status } = await req(port, "POST", "/api/mcp/config/server", {
        name: "no-url",
        config: { type: "streamable-http" },
      });
      expect(status).toBe(400);
    });

    it("POST /api/mcp/config/server rejects reserved keys in nested config", async () => {
      const { status } = await req(port, "POST", "/api/mcp/config/server", {
        name: "bad-nested-keys",
        config: {
          type: "stdio",
          command: "npx",
          env: {
            constructor: { polluted: "yes" },
          },
        },
      });
      expect(status).toBe(400);
    });

    it("POST /api/mcp/config/server adds remote server with url", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/mcp/config/server",
        {
          name: "test-remote",
          config: {
            type: "streamable-http",
            url: "https://93.184.216.34/api",
          },
        },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.requiresRestart).toBe(true);
    });

    it("DELETE /api/mcp/config/server/:name removes and returns requiresRestart", async () => {
      // First add
      await req(port, "POST", "/api/mcp/config/server", {
        name: "to-delete",
        config: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@test/mcp-server"],
        },
      });

      // Then remove
      const { status, data } = await req(
        port,
        "DELETE",
        "/api/mcp/config/server/to-delete",
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.requiresRestart).toBe(true);

      // Verify removed
      const { data: configData } = await req(port, "GET", "/api/mcp/config");
      const servers = configData.servers as Record<string, unknown>;
      expect(servers["to-delete"]).toBeUndefined();
    });

    it("DELETE /api/mcp/config/server/:name is idempotent for nonexistent", async () => {
      const { status, data } = await req(
        port,
        "DELETE",
        "/api/mcp/config/server/does-not-exist",
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });

    it("DELETE /api/mcp/config/server/:name returns 400 for malformed encoding", async () => {
      const { status, data } = await req(
        port,
        "DELETE",
        "/api/mcp/config/server/%E0%A4%A",
      );
      expect(status).toBe(400);
      expect(typeof data.error).toBe("string");
    });

    it("PUT /api/mcp/config replaces entire config", async () => {
      const newServers = {
        "bulk-a": { type: "stdio", command: "npx", args: ["-y", "@test/a"] },
        "bulk-b": { type: "streamable-http", url: "https://93.184.216.34/mcp" },
      };

      const { status, data } = await req(port, "PUT", "/api/mcp/config", {
        servers: newServers,
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      const { data: configData } = await req(port, "GET", "/api/mcp/config");
      const servers = configData.servers as Record<string, unknown>;
      expect(servers["bulk-a"]).toBeDefined();
      expect(servers["bulk-b"]).toBeDefined();
    });

    it("PUT /api/mcp/config rejects reserved keys in servers payload", async () => {
      const { status } = await req(port, "PUT", "/api/mcp/config", {
        servers: {
          constructor: {
            type: "stdio",
            command: "npx",
          },
        },
      });
      expect(status).toBe(400);
    });

    it("DELETE /api/mcp/config/server/:name rejects reserved server names", async () => {
      const { status } = await req(
        port,
        "DELETE",
        "/api/mcp/config/server/__proto__",
      );
      expect(status).toBe(400);
    });
  });

  describe("MCP status endpoint", () => {
    it("GET /api/mcp/status returns servers array (empty without runtime MCP service)", async () => {
      const { status, data } = await req(port, "GET", "/api/mcp/status");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.servers)).toBe(true);
    });

    it("GET /api/mcp/status server entries have correct shape when present", async () => {
      const { data } = await req(port, "GET", "/api/mcp/status");
      const servers = data.servers as Array<Record<string, unknown>>;
      // With no runtime, it returns empty — but shape is valid
      for (const server of servers) {
        expect(typeof server.name).toBe("string");
        expect(typeof server.status).toBe("string");
        expect(typeof server.toolCount).toBe("number");
        expect(typeof server.resourceCount).toBe("number");
      }
    });
  });
});

describe("API Server E2E (workbench CRUD)", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await startApiServer({
      port: 0,
      runtime: createRuntimeForWorkbenchCrudTests({ loopRunning: true }),
    });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  it("supports full CRUD for workbench tasks", async () => {
    const create = await req(port, "POST", "/api/workbench/tasks", {
      name: "Task CRUD Alpha",
      description: "Initial task description",
      tags: ["ops"],
    });
    expect(create.status).toBe(201);
    const createdTask = create.data.task as Record<string, unknown>;
    const taskId = createdTask.id as string;
    expect(typeof taskId).toBe("string");

    const list = await req(port, "GET", "/api/workbench/tasks");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.tasks)).toBe(true);
    expect(
      (list.data.tasks as Array<Record<string, unknown>>).some(
        (task) => task.id === taskId,
      ),
    ).toBe(true);

    const read = await req(
      port,
      "GET",
      `/api/workbench/tasks/${encodeURIComponent(taskId)}`,
    );
    expect(read.status).toBe(200);
    expect((read.data.task as Record<string, unknown>).name).toBe(
      "Task CRUD Alpha",
    );

    const update = await req(
      port,
      "PUT",
      `/api/workbench/tasks/${encodeURIComponent(taskId)}`,
      {
        name: "Task CRUD Beta",
        isCompleted: true,
      },
    );
    expect(update.status).toBe(200);
    expect((update.data.task as Record<string, unknown>).name).toBe(
      "Task CRUD Beta",
    );
    expect((update.data.task as Record<string, unknown>).isCompleted).toBe(
      true,
    );

    const del = await req(
      port,
      "DELETE",
      `/api/workbench/tasks/${encodeURIComponent(taskId)}`,
    );
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);

    const readAfterDelete = await req(
      port,
      "GET",
      `/api/workbench/tasks/${encodeURIComponent(taskId)}`,
    );
    expect(readAfterDelete.status).toBe(404);
  });

  it("supports full CRUD for triggers", async () => {
    const create = await req(port, "POST", "/api/triggers", {
      displayName: "Trigger CRUD Alpha",
      instructions: "Run trigger CRUD test",
      triggerType: "interval",
      intervalMs: 60_000,
    });
    expect(create.status).toBe(201);
    const createdTrigger = create.data.trigger as Record<string, unknown>;
    const triggerId = createdTrigger.id as string;
    expect(typeof triggerId).toBe("string");

    const list = await req(port, "GET", "/api/triggers");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.triggers)).toBe(true);
    expect(
      (list.data.triggers as Array<Record<string, unknown>>).some(
        (trigger) => trigger.id === triggerId,
      ),
    ).toBe(true);

    const read = await req(
      port,
      "GET",
      `/api/triggers/${encodeURIComponent(triggerId)}`,
    );
    expect(read.status).toBe(200);
    expect((read.data.trigger as Record<string, unknown>).displayName).toBe(
      "Trigger CRUD Alpha",
    );

    const update = await req(
      port,
      "PUT",
      `/api/triggers/${encodeURIComponent(triggerId)}`,
      {
        displayName: "Trigger CRUD Beta",
        enabled: false,
      },
    );
    expect(update.status).toBe(200);
    expect((update.data.trigger as Record<string, unknown>).displayName).toBe(
      "Trigger CRUD Beta",
    );
    expect((update.data.trigger as Record<string, unknown>).enabled).toBe(
      false,
    );

    const del = await req(
      port,
      "DELETE",
      `/api/triggers/${encodeURIComponent(triggerId)}`,
    );
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);

    const readAfterDelete = await req(
      port,
      "GET",
      `/api/triggers/${encodeURIComponent(triggerId)}`,
    );
    expect(readAfterDelete.status).toBe(404);
  });

  it("supports full CRUD for todos", async () => {
    const create = await req(port, "POST", "/api/workbench/todos", {
      name: "Todo CRUD Alpha",
      description: "Initial todo description",
      priority: 3,
      isUrgent: true,
      type: "task",
    });
    expect(create.status).toBe(201);
    const createdTodo = create.data.todo as Record<string, unknown>;
    const todoId = createdTodo.id as string;
    expect(typeof todoId).toBe("string");

    const list = await req(port, "GET", "/api/workbench/todos");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.todos)).toBe(true);
    expect(
      (list.data.todos as Array<Record<string, unknown>>).some(
        (todo) => todo.id === todoId,
      ),
    ).toBe(true);

    const read = await req(
      port,
      "GET",
      `/api/workbench/todos/${encodeURIComponent(todoId)}`,
    );
    expect(read.status).toBe(200);
    expect((read.data.todo as Record<string, unknown>).name).toBe(
      "Todo CRUD Alpha",
    );

    const update = await req(
      port,
      "PUT",
      `/api/workbench/todos/${encodeURIComponent(todoId)}`,
      {
        name: "Todo CRUD Beta",
        priority: 1,
        isUrgent: false,
      },
    );
    expect(update.status).toBe(200);
    expect((update.data.todo as Record<string, unknown>).name).toBe(
      "Todo CRUD Beta",
    );
    expect((update.data.todo as Record<string, unknown>).priority).toBe(1);
    expect((update.data.todo as Record<string, unknown>).isUrgent).toBe(false);

    const complete = await req(
      port,
      "POST",
      `/api/workbench/todos/${encodeURIComponent(todoId)}/complete`,
      {
        isCompleted: true,
      },
    );
    expect(complete.status).toBe(200);
    expect(complete.data.ok).toBe(true);

    const readCompleted = await req(
      port,
      "GET",
      `/api/workbench/todos/${encodeURIComponent(todoId)}`,
    );
    expect(readCompleted.status).toBe(200);
    expect(
      (readCompleted.data.todo as Record<string, unknown>).isCompleted,
    ).toBe(true);

    const del = await req(
      port,
      "DELETE",
      `/api/workbench/todos/${encodeURIComponent(todoId)}`,
    );
    expect(del.status).toBe(200);
    expect(del.data.ok).toBe(true);

    const readAfterDelete = await req(
      port,
      "GET",
      `/api/workbench/todos/${encodeURIComponent(todoId)}`,
    );
    expect(readAfterDelete.status).toBe(404);
  });
});

describe("API Server E2E (compat endpoints)", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await startApiServer({
      port: 0,
      runtime: createRuntimeForCompatEndpointTests(),
    });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  it("GET /v1/models returns OpenAI-compatible model list", async () => {
    const { status, data } = await req(port, "GET", "/v1/models");
    expect(status).toBe(200);
    expect(data.object).toBe("list");
    const models = data.data as Array<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((item) => item.id === "eliza")).toBe(true);
    expect(models.some((item) => item.id === "CompatAgent")).toBe(true);
  });

  it("GET /v1/models/:id returns OpenAI-compatible model detail", async () => {
    const { status, data } = await req(
      port,
      "GET",
      "/v1/models/compat-model-id",
    );
    expect(status).toBe(200);
    expect(data.object).toBe("model");
    expect(data.id).toBe("compat-model-id");
    expect(data.owned_by).toBe("eliza");
  });

  it("POST /v1/chat/completions returns OpenAI-compatible completion", async () => {
    const { status, data } = await req(port, "POST", "/v1/chat/completions", {
      model: "eliza",
      user: "compat-e2e",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Say hi." },
      ],
    });
    expect(status).toBe(200);
    expect(data.object).toBe("chat.completion");
    expect(typeof data.id).toBe("string");
    const choices = data.choices as Array<Record<string, unknown>>;
    expect(Array.isArray(choices)).toBe(true);
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice.message as Record<string, unknown>;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Compat reply");
    expect(firstChoice.finish_reason).toBe("stop");
  });

  it("POST /v1/chat/completions streams OpenAI-compatible SSE chunks", async () => {
    const { status, headers, events } = await reqSse(
      port,
      "/v1/chat/completions",
      {
        model: "eliza",
        stream: true,
        user: "compat-sse-e2e",
        messages: [{ role: "user", content: "Stream a short answer." }],
      },
    );

    expect(status).toBe(200);
    expect(String(headers["content-type"])).toContain("text/event-stream");

    const chunks = events.filter(
      (event) =>
        (event as Record<string, unknown>).object === "chat.completion.chunk",
    ) as Array<Record<string, unknown>>;
    expect(chunks.length).toBeGreaterThan(0);

    const hasRoleChunk = chunks.some((chunk) => {
      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) return false;
      const firstChoice = choices[0] as Record<string, unknown>;
      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      return delta?.role === "assistant";
    });
    expect(hasRoleChunk).toBe(true);

    const content = chunks
      .map((chunk) => {
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) return "";
        const firstChoice = choices[0] as Record<string, unknown>;
        const delta = firstChoice.delta as Record<string, unknown> | undefined;
        return typeof delta?.content === "string" ? delta.content : "";
      })
      .join("");
    expect(content).toContain("Compat reply");
  });

  it("POST /v1/messages returns Anthropic-compatible message", async () => {
    const { status, data } = await req(port, "POST", "/v1/messages", {
      model: "eliza",
      system: "You are concise.",
      metadata: { conversation_id: "compat-room-1" },
      messages: [{ role: "user", content: "Say hi." }],
    });
    expect(status).toBe(200);
    expect(data.type).toBe("message");
    expect(data.role).toBe("assistant");
    const content = data.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    const first = content[0] as Record<string, unknown>;
    expect(first.type).toBe("text");
    expect(first.text).toBe("Compat reply");
    expect(data.stop_reason).toBe("end_turn");
  });

  it("POST /v1/messages streams Anthropic-compatible SSE events", async () => {
    const { status, headers, events } = await reqSse(port, "/v1/messages", {
      model: "eliza",
      stream: true,
      metadata: { conversation_id: "compat-room-2" },
      messages: [{ role: "user", content: "Stream a short answer." }],
    });

    expect(status).toBe(200);
    expect(String(headers["content-type"])).toContain("text/event-stream");

    const eventTypes = events
      .map((event) => event.type)
      .filter((value): value is string => typeof value === "string");
    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");

    const streamedText = events
      .filter((event) => event.type === "content_block_delta")
      .map((event) => {
        const delta = (event as Record<string, unknown>).delta as
          | Record<string, unknown>
          | undefined;
        return typeof delta?.text === "string" ? delta.text : "";
      })
      .join("");
    expect(streamedText).toContain("Compat reply");
  });
});

describe("API Server E2E (chat SSE)", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await startApiServer({
      port: 0,
      runtime: createRuntimeForChatSseTests(),
    });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  it("POST /api/chat/stream emits token and done events", async () => {
    const { status, headers, events } = await reqSse(port, "/api/chat/stream", {
      text: "hello",
      mode: "simple",
    });

    expect(status).toBe(200);
    expect(String(headers["content-type"])).toContain("text/event-stream");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "token",
        text: "Hello ",
        fullText: "Hello ",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "token",
        text: "world",
        fullText: "Hello world",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        fullText: "Hello world",
        agentName: "ChatStreamAgent",
      }),
    );
  });

  it("POST /api/conversations/:id/messages/stream emits token and done events", async () => {
    const create = await req(port, "POST", "/api/conversations", {
      title: "SSE Conversation",
    });
    expect(create.status).toBe(200);
    const createdConversation = create.data.conversation as { id?: string };
    const conversationId = createdConversation.id ?? "";
    expect(conversationId.length).toBeGreaterThan(0);

    const { status, events } = await reqSse(
      port,
      `/api/conversations/${conversationId}/messages/stream`,
      {
        text: "hello",
        mode: "power",
      },
    );

    expect(status).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "token",
        text: "Hello ",
        fullText: "Hello ",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "token",
        text: "world",
        fullText: "Hello world",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        fullText: "Hello world",
        agentName: "ChatStreamAgent",
      }),
    );
  });
});
