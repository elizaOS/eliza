/**
 * HTTP harness coverage for the cloud-agent entrypoint. The test captures the
 * real `node:http` request handlers before they bind sockets, then drives health,
 * snapshot, restore, bridge, stream, and status requests through the same code
 * the Docker image runs.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedServer = {
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const capturedServers: CapturedServer[] = [];

vi.mock("node:http", () => ({
  createServer: vi.fn(
    (
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => void | Promise<void>,
    ) => {
      const server = {
        handler,
        listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
          cb?.();
          return server;
        }),
        close: vi.fn(),
      };
      capturedServers.push(server);
      return server;
    },
  ),
}));

vi.mock("@elizaos/core", () => {
  throw new Error("force echo-mode fallback");
});

type FakeResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
};

function makeResponse(): FakeResponse {
  return {
    body: "",
    headers: {},
    statusCode: 200,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = value;
      }
      return this;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      return this;
    },
  } as FakeResponse;
}

function makeRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit("data", Buffer.from(body));
      req.emit("end");
    });
  }
  return req;
}

async function dispatch(
  server: CapturedServer,
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<FakeResponse> {
  const res = makeResponse();
  await server.handler(makeRequest(method, url, body, headers), res);
  return res;
}

function parseJson(res: FakeResponse): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function waitForEchoRuntime(healthServer: CapturedServer): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await dispatch(healthServer, "GET", "/api/health");
    if (parseJson(res).runtimeReady === true) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("echo runtime did not become ready");
}

describe("startCloudAgent HTTP handlers", () => {
  const originalEnv = { ...process.env };
  let onSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedServers.length = 0;
    process.env = { ...originalEnv };
    onSpy = vi.spyOn(process, "on").mockReturnValue(process);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    onSpy.mockRestore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it.each(["Ω", "€", "😀"])(
    "preserves complete restored state when %s spans request chunks",
    async (codePoint) => {
      const { startCloudAgent } = await import("./cloud-agent-shared");
      startCloudAgent({ port: 0, bridgePort: 0, bridgeSecret: "secret" });
      await waitForEchoRuntime(capturedServers[0]);
      const bridge = capturedServers[1];
      const expected = {
        memories: [{ text: "Complete memory Ω" }],
        config: { name: "Unicode restore" },
        workspaceFiles: {
          "notes.txt": `before ${codePoint} after \uFEFF retained`,
        },
      };
      const bytes = Buffer.from(JSON.stringify(expected));
      const split =
        bytes.indexOf(
          Buffer.from(codePoint),
          bytes.indexOf(Buffer.from("workspaceFiles")),
        ) + 1;
      const req = makeRequest("POST", "/api/restore", undefined, {
        authorization: "Bearer secret",
      });
      const res = makeResponse();
      const pending = bridge.handler(req, res);
      req.emit("data", bytes.subarray(0, split));
      req.emit("data", bytes.subarray(split));
      req.emit("end");
      await pending;
      expect(res.statusCode).toBe(200);
      const snapshot = parseJson(
        await dispatch(bridge, "POST", "/api/snapshot", undefined, {
          authorization: "Bearer secret",
        }),
      );
      expect({
        memories: snapshot.memories,
        config: snapshot.config,
        workspaceFiles: snapshot.workspaceFiles,
      }).toEqual(expected);
    },
  );

  it.each([
    ["/api/restore", "malformed"],
    ["/api/restore", "truncated"],
    ["/bridge", "malformed"],
    ["/bridge/stream", "truncated"],
    ["/api/conversations/personal%3Atest/import", "malformed"],
  ])("rejects %s %s UTF-8 without changing state", async (path, encoding) => {
    const { startCloudAgent } = await import("./cloud-agent-shared");
    startCloudAgent({ port: 0, bridgePort: 0, bridgeSecret: "secret" });
    await waitForEchoRuntime(capturedServers[0]);
    const bridge = capturedServers[1];
    const auth = { authorization: "Bearer secret" };
    const expected = {
      memories: [{ text: "Retained Ω😀" }],
      config: { name: "Original" },
      workspaceFiles: { "notes.txt": "Complete original" },
    };
    expect(
      (
        await dispatch(
          bridge,
          "POST",
          "/api/restore",
          JSON.stringify(expected),
          auth,
        )
      ).statusCode,
    ).toBe(200);
    const req = makeRequest("POST", path, undefined, auth);
    const res = makeResponse();
    const pending = bridge.handler(req, res);
    req.emit("data", Buffer.from('{"config":{"name":"'));
    req.emit(
      "data",
      Buffer.from(encoding === "malformed" ? [0xff] : [0xf0, 0x9f]),
    );
    req.emit("end");
    await pending;
    expect(res.statusCode).toBe(400);
    expect(parseJson(res)).toEqual({
      error: "Request body must contain complete valid UTF-8",
      code: "CLOUD_AGENT_INVALID_UTF8",
    });
    const snapshot = parseJson(
      await dispatch(bridge, "POST", "/api/snapshot", undefined, auth),
    );
    expect({
      memories: snapshot.memories,
      config: snapshot.config,
      workspaceFiles: snapshot.workspaceFiles,
    }).toEqual(expected);
  });

  it("rejects a leading UTF-8 BOM without changing restored state", async () => {
    const { startCloudAgent } = await import("./cloud-agent-shared");
    startCloudAgent({ port: 0, bridgePort: 0, bridgeSecret: "secret" });
    await waitForEchoRuntime(capturedServers[0]);
    const bridge = capturedServers[1];
    const auth = { authorization: "Bearer secret" };
    const before = parseJson(
      await dispatch(bridge, "POST", "/api/snapshot", undefined, auth),
    );
    const response = await dispatch(
      bridge,
      "POST",
      "/api/restore",
      '\uFEFF{"config":{"name":"Unexpected replacement"}}',
      auth,
    );
    expect(response.statusCode).toBe(400);
    const after = parseJson(
      await dispatch(bridge, "POST", "/api/snapshot", undefined, auth),
    );
    expect({
      memories: after.memories,
      config: after.config,
      workspaceFiles: after.workspaceFiles,
    }).toEqual({
      memories: before.memories,
      config: before.config,
      workspaceFiles: before.workspaceFiles,
    });
  });

  it("still destroys an oversized body after malformed UTF-8", async () => {
    const { startCloudAgent } = await import("./cloud-agent-shared");
    startCloudAgent({
      port: 0,
      bridgePort: 0,
      bridgeSecret: "secret",
      maxBodyBytes: 40,
    });
    await waitForEchoRuntime(capturedServers[0]);
    const bridge = capturedServers[1];
    const auth = { authorization: "Bearer secret" };
    const before = parseJson(
      await dispatch(bridge, "POST", "/api/snapshot", undefined, auth),
    );
    const req = makeRequest("POST", "/api/restore", undefined, auth);
    req.destroy = vi.fn(() => req);
    const res = makeResponse();
    const pending = bridge.handler(req, res);
    req.emit("data", Buffer.from([0xff]));
    req.emit("data", Buffer.alloc(64, 0x20));
    req.emit("end");
    await pending;
    expect(req.destroy).toHaveBeenCalledOnce();
    const after = parseJson(
      await dispatch(bridge, "POST", "/api/snapshot", undefined, auth),
    );
    expect({
      memories: after.memories,
      config: after.config,
      workspaceFiles: after.workspaceFiles,
    }).toEqual({
      memories: before.memories,
      config: before.config,
      workspaceFiles: before.workspaceFiles,
    });
  });

  it("routes health, snapshot, restore, message, stream, and status requests", async () => {
    const { startCloudAgent } = await import("./cloud-agent-shared");
    startCloudAgent({
      port: 0,
      bridgePort: 0,
      bridgeSecret: "secret",
      maxMemories: 2,
      enableChatMode: true,
    });
    await Promise.resolve();

    expect(capturedServers).toHaveLength(2);
    const [healthServer, bridgeServer] = capturedServers;

    const initializingHealth = await dispatch(
      healthServer,
      "GET",
      "/api/health",
    );
    expect(initializingHealth.statusCode).toBe(503);
    expect(parseJson(initializingHealth)).toMatchObject({
      status: "initializing",
      runtimeReady: false,
    });

    const initializingBridgeHealth = await dispatch(
      bridgeServer,
      "GET",
      "/api/health",
      undefined,
      { authorization: "Bearer secret" },
    );
    expect(initializingBridgeHealth.statusCode).toBe(503);
    expect(parseJson(initializingBridgeHealth)).toMatchObject({
      status: "initializing",
      runtimeReady: false,
    });

    await waitForEchoRuntime(healthServer);

    const greenHealth = await dispatch(healthServer, "GET", "/api/health");
    expect(greenHealth.statusCode).toBe(200);
    expect(parseJson(greenHealth)).toMatchObject({
      status: "healthy",
      runtimeReady: true,
      database: "ok",
      databaseLiveness: { ok: true, status: "unknown", terminal: false },
    });

    const root = await dispatch(healthServer, "GET", "/");
    expect(parseJson(root)).toMatchObject({
      service: "elizaos-cloud-agent",
      status: "running",
    });
    expect((await dispatch(healthServer, "GET", "/missing")).statusCode).toBe(
      404,
    );

    const unauthorized = await dispatch(bridgeServer, "POST", "/bridge", "{}");
    expect(unauthorized.statusCode).toBe(401);

    const auth = { authorization: "Bearer secret" };
    const cutoverImport = await dispatch(
      bridgeServer,
      "POST",
      "/api/conversations/personal%3Atest/import",
      JSON.stringify({
        messages: [],
        scheduledTasks: [],
        todoSnapshot: { todos: [], mutations: [], digest: "digest" },
      }),
      auth,
    );
    expect(parseJson(cutoverImport)).toMatchObject({
      conversationId: "personal:test",
      complete: true,
      sourceMessageCount: 0,
      inserted: 0,
      skipped: 0,
      sourceTodoCount: 0,
      sourceTodoDigest: "digest",
      targetTodoDigest: "digest",
    });

    const message = await dispatch(
      bridgeServer,
      "POST",
      "/bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message.send",
        params: {
          text: "hello",
          roomId: " room-a ",
          mode: "simple",
          channelType: "GROUP",
          source: "discord",
          sender: {
            id: " user-1 ",
            username: " sol ",
            displayName: " Sol ",
            metadata: { role: "tester" },
          },
          metadata: { trace: "m1" },
        },
      }),
      auth,
    );
    expect(parseJson(message)).toMatchObject({
      result: { text: "[echo] hello" },
    });

    const status = await dispatch(
      bridgeServer,
      "POST",
      "/bridge",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "status.get" }),
      auth,
    );
    const statusBody = parseJson(status);
    expect(statusBody).toMatchObject({
      result: {
        status: "running",
        memoriesCount: 2,
        database: "ok",
      },
    });
    // The RPC status boundary must carry the same public projection as HTTP
    // health: classification fields only, never the internal probe diagnostic.
    const statusLiveness = (statusBody.result as Record<string, unknown>)
      .databaseLiveness as Record<string, unknown>;
    expect(Object.keys(statusLiveness).sort()).toEqual([
      "ok",
      "status",
      "terminal",
    ]);

    const snapshot = await dispatch(
      bridgeServer,
      "POST",
      "/api/snapshot",
      "",
      auth,
    );
    expect(parseJson(snapshot)).toMatchObject({
      memories: expect.any(Array),
      config: {},
      workspaceFiles: {},
    });

    const restore = await dispatch(
      bridgeServer,
      "POST",
      "/api/restore",
      JSON.stringify({
        memories: [{ role: "user", text: "restored" }],
        config: { name: "restored" },
        workspaceFiles: { "README.md": "ok" },
      }),
      auth,
    );
    expect(parseJson(restore)).toEqual({ success: true });

    const stream = await dispatch(
      bridgeServer,
      "POST",
      "/bridge/stream",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "s1",
        method: "message.send",
        params: { text: "stream me" },
      }),
      auth,
    );
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.body).toContain("event: connected");
    expect(stream.body).toContain("event: chunk");
    expect(stream.body).toContain("event: done");

    const heartbeat = await dispatch(
      bridgeServer,
      "POST",
      "/bridge",
      JSON.stringify({ jsonrpc: "2.0", method: "heartbeat" }),
      auth,
    );
    expect(parseJson(heartbeat)).toMatchObject({
      method: "heartbeat.ack",
    });

    const badJson = await dispatch(bridgeServer, "POST", "/bridge", "{", auth);
    expect(badJson.statusCode).toBe(400);

    const notFoundMethod = await dispatch(
      bridgeServer,
      "POST",
      "/bridge",
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "missing.method" }),
      auth,
    );
    expect(parseJson(notFoundMethod)).toMatchObject({
      error: { code: -32601 },
    });
    expect(
      (await dispatch(bridgeServer, "POST", "/missing", "", auth)).statusCode,
    ).toBe(404);
  });
});
