import { Readable } from "node:stream";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodingAgentRoutes } from "../api/routes.js";

function makeRequest(
  url: string,
  options: { method?: string; remoteAddress?: string } = {},
) {
  const req = Readable.from([]) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    socket?: { remoteAddress?: string };
  };
  req.method = options.method ?? "GET";
  req.url = url;
  req.headers = { host: "localhost:2138" };
  req.socket = { remoteAddress: options.remoteAddress ?? "127.0.0.1" };
  return req;
}

function makeResponse() {
  let statusCode = 200;
  let body = "";
  const res = {
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk;
    },
    getStatus: () => statusCode,
    getBody: () => body,
    getJson: <T = unknown>() => JSON.parse(body) as T,
  };
  return res as unknown as import("node:http").ServerResponse & {
    getStatus: () => number;
    getBody: () => string;
    getJson: <T = unknown>() => T;
  };
}

function buildRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  const runtime = {
    agentId: "agent-parent",
    character: {
      name: "Milady",
      bio: ["local-first assistant"],
      knowledge: [{ item: { case: "path", value: "docs/context.md" } }],
    },
    getRoom: vi.fn(async (roomId: string) => ({
      id: roomId,
      channelId: "discord-channel-1",
      source: "discord",
      type: "DM",
      worldId: "world-1",
    })),
    useModel: vi.fn(async (modelType: string, params: { text: string }) => {
      expect(modelType).toBe(ModelType.TEXT_EMBEDDING);
      expect(params.text).toBe("dad");
      return [0.1, 0.2, 0.3];
    }),
    searchMemories: vi.fn(async ({ tableName }: { tableName: string }) => [
      {
        id: `${tableName}-1`,
        content: { text: `${tableName} hit` },
        similarity: 0.9,
        roomId: "room-1",
        createdAt: 123,
      },
    ]),
    getSetting: vi.fn(() => null),
    getService: vi.fn(),
    ...overrides,
  };
  return runtime as unknown as IAgentRuntime;
}

describe("parent runtime bridge routes", () => {
  const task = {
    threadId: "thread-1",
    sessionId: "pty-test",
    agentType: "claude",
    label: "agent",
    originalTask: "build the thing",
    workdir: "/tmp/workspace",
    status: "active",
    decisions: [],
    autoResolvedCount: 0,
    registeredAt: 1,
    lastActivityAt: 1,
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    originRoomId: "room-1",
    originMetadata: {
      roomId: "room-1",
      modelPrefs: { powerful: "claude-sonnet-test", fast: "claude-haiku-test" },
    },
  };

  const session = {
    id: "pty-test",
    name: "agent",
    agentType: "claude",
    workdir: "/tmp/workspace",
    status: "running",
    createdAt: new Date(1),
    lastActivityAt: new Date(2),
    metadata: task.originMetadata,
  };

  let runtime: IAgentRuntime;
  let ptyService: {
    getSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    checkAvailableAgents: ReturnType<typeof vi.fn>;
    getAgentMetrics: ReturnType<typeof vi.fn>;
    coordinator?: unknown;
  };
  let workspaceService: { listWorkspaces: ReturnType<typeof vi.fn> };
  let coordinator: {
    getTaskContext: ReturnType<typeof vi.fn>;
    getAllTaskContexts: ReturnType<typeof vi.fn>;
    getPendingConfirmations: ReturnType<typeof vi.fn>;
    getSupervisionLevel: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    runtime = buildRuntime();
    coordinator = {
      getTaskContext: vi.fn((id: string) =>
        id === "pty-test" ? task : undefined,
      ),
      getAllTaskContexts: vi.fn(() => [task]),
      getPendingConfirmations: vi.fn(() => []),
      getSupervisionLevel: vi.fn(() => "autonomous"),
    };
    ptyService = {
      getSession: vi.fn((id: string) =>
        id === "pty-test" ? session : undefined,
      ),
      listSessions: vi.fn(async () => [session]),
      checkAvailableAgents: vi.fn(async () => []),
      getAgentMetrics: vi.fn(() => ({})),
      coordinator,
    };
    workspaceService = {
      listWorkspaces: vi.fn(() => [
        {
          id: "ws-1",
          label: "Main",
          repo: "https://github.com/example/repo",
          branch: "develop",
          path: "/tmp/workspace",
        },
      ]),
    };
    vi.mocked(runtime.getService).mockImplementation((name: string) => {
      if (name === "PTY_SERVICE") return ptyService as never;
      if (name === "CODING_WORKSPACE_SERVICE") return workspaceService as never;
      if (name === "SWARM_COORDINATOR") return coordinator as never;
      return null;
    });
  });

  it("returns character, room, model, and workdir parent context", async () => {
    const req = makeRequest("/api/coding-agents/pty-test/parent-context");
    const res = makeResponse();

    const handled = await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/pty-test/parent-context",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    expect(handled).toBe(true);
    expect(res.getStatus()).toBe(200);
    expect(res.getJson()).toMatchObject({
      sessionId: "pty-test",
      character: {
        name: "Milady",
        bio: ["local-first assistant"],
        knowledge: ["docs/context.md"],
      },
      currentRoom: {
        id: "room-1",
        channel: "discord-channel-1",
        platform: "discord",
      },
      workdir: "/tmp/workspace",
      model: {
        agentType: "claude",
        powerful: "claude-sonnet-test",
        fast: "claude-haiku-test",
      },
    });
  });

  it("searches parent memory across memory tables with the requested limit", async () => {
    const req = makeRequest("/api/coding-agents/pty-test/memory?q=dad&limit=2");
    const res = makeResponse();

    await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/pty-test/memory",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    const payload = res.getJson<{
      query: string;
      limit: number;
      hits: Array<{ tableName: string; text: string }>;
    }>();
    expect(res.getStatus()).toBe(200);
    expect(payload.query).toBe("dad");
    expect(payload.limit).toBe(2);
    expect(payload.hits).toHaveLength(2);
    expect(payload.hits.map((hit) => hit.tableName)).toEqual([
      "facts",
      "messages",
    ]);
    expect(runtime.searchMemories).toHaveBeenCalledTimes(3);
    expect(runtime.searchMemories).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "knowledge", limit: 2 }),
    );
  });

  it("ranks parent memory hits by relevance across tables", async () => {
    vi.mocked(runtime.searchMemories).mockImplementation(
      async ({ tableName }: { tableName: string }) => {
        if (tableName === "facts") {
          return [
            {
              id: "facts-1",
              content: { text: "low relevance fact" },
              similarity: 0.1,
              roomId: "room-1",
            },
            {
              id: "facts-2",
              content: { text: "medium relevance fact" },
              similarity: 0.4,
              roomId: "room-1",
            },
          ];
        }
        if (tableName === "messages") {
          return [
            {
              id: "messages-1",
              content: { text: "high relevance message" },
              similarity: 0.95,
              roomId: "room-1",
            },
          ];
        }
        return [];
      },
    );
    const req = makeRequest("/api/coding-agents/pty-test/memory?q=dad&limit=2");
    const res = makeResponse();

    await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/pty-test/memory",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    const payload = res.getJson<{
      hits: Array<{ tableName: string; text: string }>;
    }>();
    expect(res.getStatus()).toBe(200);
    expect(
      payload.hits.map((hit) => ({
        tableName: hit.tableName,
        text: hit.text,
      })),
    ).toEqual([
      { tableName: "messages", text: "high relevance message" },
      { tableName: "facts", text: "medium relevance fact" },
    ]);
  });

  it("returns active workspace provider data read-only", async () => {
    const req = makeRequest("/api/coding-agents/pty-test/active-workspaces");
    const res = makeResponse();

    await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/pty-test/active-workspaces",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    const payload = res.getJson<{
      activeWorkspaces: Array<{ id: string; path: string }>;
      activeSessions: Array<{ id: string; workdir: string }>;
    }>();
    expect(res.getStatus()).toBe(200);
    expect(payload.activeWorkspaces).toEqual([
      expect.objectContaining({ id: "ws-1", path: "/tmp/workspace" }),
    ]);
    expect(payload.activeSessions).toEqual([
      expect.objectContaining({ id: "pty-test", workdir: "/tmp/workspace" }),
    ]);
  });

  it("rejects non-loopback callers", async () => {
    const req = makeRequest("/api/coding-agents/pty-test/parent-context", {
      remoteAddress: "203.0.113.10",
    });
    const res = makeResponse();

    await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/pty-test/parent-context",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    expect(res.getStatus()).toBe(403);
    expect(res.getJson()).toMatchObject({ code: "loopback_only" });
  });

  it("returns 410 for stale task-agent ids", async () => {
    const req = makeRequest("/api/coding-agents/missing/parent-context");
    const res = makeResponse();

    await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/missing/parent-context",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    expect(res.getStatus()).toBe(410);
    expect(res.getJson()).toMatchObject({ code: "task_no_longer_active" });
  });

  it("rejects mutation attempts", async () => {
    const req = makeRequest("/api/coding-agents/pty-test/memory?q=dad", {
      method: "POST",
    });
    const res = makeResponse();

    await handleCodingAgentRoutes(
      req as import("node:http").IncomingMessage,
      res,
      "/api/coding-agents/pty-test/memory",
      {
        runtime,
        ptyService: ptyService as never,
        workspaceService: workspaceService as never,
        coordinator: coordinator as never,
      },
    );

    expect(res.getStatus()).toBe(405);
    expect(res.getJson()).toMatchObject({ code: "method_not_allowed" });
  });
});
