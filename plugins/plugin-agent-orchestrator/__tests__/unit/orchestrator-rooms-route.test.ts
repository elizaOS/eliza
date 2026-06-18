/**
 * Guards GET /api/orchestrator/rooms (the per-room participant roster) on two
 * fronts, mirroring the accounts-route guard:
 *  1. The path template is REGISTERED in CODING_AGENT_ROUTE_PATHS — an
 *     unregistered handler 404s over real HTTP even though it exists.
 *  2. The handler dispatches to OrchestratorTaskService.getRoomRoster and
 *     groups live sessions by room: orchestrator + owning user + each
 *     sub-agent, with the active/multiParty counts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";
import { codingAgentRoutePlugin } from "../../src/setup-routes.ts";

function makeStore(): OrchestratorTaskStore {
  return new OrchestratorTaskStore({ backend: "memory" });
}

function makeService(store: OrchestratorTaskStore): OrchestratorTaskService {
  return new OrchestratorTaskService(
    {
      getService: () => null,
      getSetting: () => undefined,
      character: { name: "Eliza" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    { store },
  );
}

function session(
  over: Partial<OrchestratorTaskSession>,
): OrchestratorTaskSession {
  return {
    id: over.sessionId ?? "s",
    taskId: "t",
    sessionId: "s",
    framework: "claude",
    label: "worker",
    originalTask: "do the thing",
    workdir: "/tmp/x",
    status: "running",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: 0,
    lastActivityAt: 0,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: 0,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "measured",
    metadata: {},
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...over,
  };
}

function ctxWith(service: OrchestratorTaskService): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => true,
      getServiceLoadPromise: () => Promise.resolve(undefined),
    },
    acpService: null,
    workspaceService: null,
  } as never;
}

class CapturingResponse {
  statusCode = 0;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.body = chunk;
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

describe("GET /api/orchestrator/rooms", () => {
  it("is registered as a runtime route template", () => {
    const registered = (codingAgentRoutePlugin.routes ?? []).some(
      (r) => r.type === "GET" && r.path === "/api/orchestrator/rooms",
    );
    expect(registered).toBe(true);
  });

  it("returns an empty roster when no tasks exist", async () => {
    const service = makeService(makeStore());
    expect(await service.getRoomRoster()).toEqual({ rooms: [] });
  });

  it("groups live sessions by room with orchestrator + user + sub-agents", async () => {
    const store = makeStore();
    const service = makeService(store);
    const doc = await store.createTask({
      title: "Ship the thing",
      goal: "ship it",
      ownerUserId: "user-42",
      roomId: "room-1",
      taskRoomId: "taskroom-1",
    });
    const taskId = doc.task.id;
    await store.addSession(
      session({
        taskId,
        sessionId: "sess-a",
        label: "alpha",
        framework: "claude",
        status: "running",
        accountProviderId: "anthropic-subscription",
        accountId: "acct-work",
        accountLabel: "Work",
        outputTokens: 120,
      }),
    );
    await store.addSession(
      session({
        taskId,
        sessionId: "sess-b",
        label: "beta",
        framework: "codex",
        status: "running",
        accountProviderId: "openai-codex",
        accountId: "acct-personal",
        accountLabel: "Personal",
      }),
    );
    await store.addSession(
      session({
        taskId,
        sessionId: "sess-c",
        label: "gamma",
        status: "stopped",
      }),
    );

    const { rooms } = await service.getRoomRoster();
    expect(rooms).toHaveLength(1);
    const room = rooms[0];
    expect(room.taskId).toBe(taskId);
    expect(room.roomId).toBe("room-1");
    expect(room.taskRoomId).toBe("taskroom-1");
    expect(room.activeAgentCount).toBe(2); // two running, one stopped
    expect(room.multiParty).toBe(true);

    const kinds = room.participants.map((p) => p.kind);
    expect(kinds[0]).toBe("orchestrator");
    expect(room.participants[0].label).toBe("Eliza");
    expect(kinds).toContain("user");
    expect(room.participants.find((p) => p.kind === "user")?.id).toBe(
      "user-42",
    );
    expect(kinds.filter((k) => k === "sub_agent")).toHaveLength(3);

    const alpha = room.participants.find((p) => p.id === "sess-a");
    expect(alpha?.accountLabel).toBe("Work");
    expect(alpha?.active).toBe(true);
    expect(alpha?.totalTokens).toBe(120);
    expect(room.participants.find((p) => p.id === "sess-c")?.active).toBe(
      false,
    );
  });

  it("omits rooms with no sub-agent sessions", async () => {
    const store = makeStore();
    const service = makeService(store);
    await store.createTask({ title: "empty", goal: "noop", ownerUserId: "u1" });
    expect((await service.getRoomRoster()).rooms).toHaveLength(0);
  });

  it("serves the roster shape over the route", async () => {
    const service = makeService(makeStore());
    const req = Object.assign(Readable.from([]), {
      method: "GET",
      url: "/api/orchestrator/rooms",
    }) as unknown as IncomingMessage;
    const res = new CapturingResponse();
    const matched = await handleOrchestratorRoutes(
      req,
      res as unknown as ServerResponse,
      "/api/orchestrator/rooms",
      ctxWith(service),
    );
    expect(matched).toBe(true);
    expect(res.statusCode === 0 || res.statusCode === 200).toBe(true);
    expect(Array.isArray(res.json().rooms)).toBe(true);
  });
});
