/** Verifies Capacitor REST-only loopback transport through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Integration coverage for Capacitor's REST-only loopback transport against a
 * real ephemeral TCP server. The HTTP and SSE paths use no transport mock or model.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { __resetNetworkStatusForTests, ElizaClient } from "./client-base";
import type { ApiError } from "./client-types";

interface CapturedRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
}

const requests: CapturedRequest[] = [];
let server: Server;
let serverBaseUrl = "";

function stubWindowProtocol(protocol: string): void {
  const jsdomWindow = window;
  const location = new Proxy(jsdomWindow.location, {
    get(target, property) {
      if (property === "protocol") return protocol;
      return Reflect.get(target, property, target);
    },
  });
  vi.stubGlobal(
    "window",
    new Proxy(jsdomWindow, {
      get(target, property) {
        if (property === "location") return location;
        return Reflect.get(target, property, target);
      },
    }),
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({
      body: Buffer.concat(bodyChunks).toString("utf8"),
      headers: request.headers,
      method: request.method ?? "GET",
      path,
    });

    switch (path) {
      case "/api/health":
        sendJson(response, 200, { ok: true, transport: "rest" });
        return;
      case "/api/no-content":
        response.writeHead(204);
        response.end();
        return;
      case "/api/bad-json":
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not-json");
        return;
      case "/api/rate-limited":
        sendJson(
          response,
          429,
          { error: "slow down", code: "rate_limited", retryAfter: 3 },
          { "retry-after": "7" },
        );
        return;
      case "/api/progress":
        sendJson(response, 202, { status: "starting", progress: 0.4 });
        return;
      case "/api/conversations/capacitor/messages/stream":
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        });
        response.end(
          'data: {"type":"status","kind":"running_tool","toolName":"LOOKUP"}\n\n' +
            'data: {"type":"tool","phase":"call","callId":"call-1","toolName":"LOOKUP","args":{"id":16843}}\n\n' +
            'data: {"type":"token","text":"Hello "}\n\n' +
            'data: {"type":"tool","phase":"result","callId":"call-1","toolName":"LOOKUP","result":{"ok":true}}\n\n' +
            'data: {"type":"token","text":"from iOS"}\n\n' +
            'data: {"type":"done","fullText":"Hello from iOS","agentName":"Eliza","thought":"REST path verified","usage":{"promptTokens":2,"completionTokens":3,"totalTokens":5,"model":"integration"},"actionResults":[{"actionName":"LOOKUP","success":true}]}\n\n',
        );
        return;
      default:
        sendJson(response, 404, { error: `unexpected route: ${path}` });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  serverBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  requests.length = 0;
  stubWindowProtocol("capacitor:");
  __resetNetworkStatusForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetNetworkStatusForTests();
});

describe("Capacitor REST-only loopback transport", () => {
  it("stays connected and reaches the authenticated health endpoint without constructing a websocket", async () => {
    const websocketConstructor = vi.fn(() => {
      throw new Error("Capacitor must not construct a cleartext WebSocket");
    });
    class WebSocketTrap {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;

      constructor() {
        websocketConstructor();
      }
    }
    vi.stubGlobal("WebSocket", WebSocketTrap);
    const client = new ElizaClient(serverBaseUrl, "ios-token");
    client.setUiLanguage("en-US");

    client.connectWs();
    const health = await client.fetch<{ ok: boolean; transport: string }>(
      "/api/health",
    );

    expect(websocketConstructor).not.toHaveBeenCalled();
    expect(client.getConnectionState()).toMatchObject({
      state: "connected",
      reconnectAttempt: 0,
      disconnectedAt: null,
    });
    expect(health).toEqual({ ok: true, transport: "rest" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/health" });
    expect(requests[0].headers.authorization).toBe("Bearer ios-token");
    expect(requests[0].headers["x-elizaos-client-id"]).toEqual(
      expect.any(String),
    );
    expect(requests[0].headers["x-elizaos-ui-language"]).toBe("en-US");
  });

  it("preserves JSON, empty, progress, and typed HTTP error semantics over REST", async () => {
    const client = new ElizaClient(serverBaseUrl, "ios-token");

    await expect(client.fetch("/api/no-content")).resolves.toBeUndefined();
    await expect(client.fetch("/api/bad-json")).rejects.toMatchObject({
      kind: "parse",
      path: "/api/bad-json",
      status: 200,
    } satisfies Partial<ApiError>);
    await expect(client.fetch("/api/rate-limited")).rejects.toMatchObject({
      kind: "http",
      path: "/api/rate-limited",
      status: 429,
      code: "rate_limited",
      retryAfter: 3,
      message: "slow down",
    } satisfies Partial<ApiError>);

    const progress = await client.fetch<{ status: string; progress: number }>(
      "/api/progress",
      undefined,
      {
        skipResume: true,
        on202: (body) => body as { status: string; progress: number },
      },
    );
    expect(progress).toEqual({ status: "starting", progress: 0.4 });

    const allowed = await client.rawRequest("/api/rate-limited", undefined, {
      allowNonOk: true,
    });
    expect(allowed.status).toBe(429);
    expect(await allowed.json()).toMatchObject({ code: "rate_limited" });
  });

  it("streams a complete chat turn through the real REST/SSE path", async () => {
    const client = new ElizaClient(serverBaseUrl, "ios-token");
    const tokens: Array<[string, string | undefined]> = [];
    const statuses: unknown[] = [];
    const tools: unknown[] = [];

    const result = await client.streamChatEndpoint(
      "/api/conversations/capacitor/messages/stream",
      "verify iOS transport",
      (token, accumulated) => tokens.push([token, accumulated]),
      "GROUP",
      undefined,
      [
        {
          data: "aW1hZ2U=",
          mimeType: "image/png",
          name: "proof.png",
          thumbnail: { data: "dGh1bWI=", mimeType: "image/png" },
        },
      ],
      { source: "ios-smoke" },
      (status) => statuses.push(status),
      (tool) => tools.push(tool),
      "ios-message-16843",
    );

    expect(tokens).toEqual([
      ["Hello ", "Hello "],
      ["from iOS", "Hello from iOS"],
    ]);
    expect(statuses).toEqual([{ kind: "running_tool", toolName: "LOOKUP" }]);
    expect(tools).toEqual([
      {
        phase: "call",
        callId: "call-1",
        toolName: "LOOKUP",
        args: { id: 16843 },
      },
      {
        phase: "result",
        callId: "call-1",
        toolName: "LOOKUP",
        result: { ok: true },
      },
    ]);
    expect(result).toEqual({
      text: "Hello from iOS",
      agentName: "Eliza",
      completed: true,
      reasoning: "REST path verified",
      usage: {
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
        model: "integration",
      },
      actionResults: [{ actionName: "LOOKUP", success: true }],
    });

    const streamRequest = requests.find(
      (request) =>
        request.path === "/api/conversations/capacitor/messages/stream",
    );
    expect(streamRequest).toMatchObject({ method: "POST" });
    expect(JSON.parse(streamRequest?.body ?? "{}")).toEqual({
      text: "verify iOS transport",
      channelType: "GROUP",
      clientMessageId: "ios-message-16843",
      streamProtocol: "delta-v2",
      images: [
        {
          data: "aW1hZ2U=",
          mimeType: "image/png",
          name: "proof.png",
          thumbnail: { data: "dGh1bWI=", mimeType: "image/png" },
        },
      ],
      metadata: { source: "ios-smoke" },
    });
  });
});
