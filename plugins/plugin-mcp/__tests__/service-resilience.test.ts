/**
 * Tests McpService failure containment: one server's connection failure must not
 * abort sibling connections or fail service start, and benign HTTP stream
 * timeout/disconnect noise must not tear down a working connection.
 * Deterministic unit harness — real service instances with stubbed
 * connection internals.
 */
import { ElizaError } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpService } from "../src/service";
import type { McpConnection, McpServerConfig } from "../src/types";

type ResilienceInternals = {
  runtime: { reportError: ReturnType<typeof vi.fn> };
  connections: Map<string, McpConnection>;
  connectionStates: Map<string, unknown>;
  initializeConnection: (name: string, config: McpServerConfig) => Promise<void>;
  buildStdioClientTransport: (
    name: string,
    config: McpServerConfig
  ) => Promise<McpConnection["transport"]>;
  updateServerConnections: (configs: Record<string, McpServerConfig>) => Promise<void>;
  setupTransportHandlers: (name: string, connection: McpConnection, state: unknown) => void;
};

const STDIO_A: McpServerConfig = { type: "stdio", command: "bun", args: ["a.mjs"] };
const STDIO_B: McpServerConfig = { type: "stdio", command: "bun", args: ["b.mjs"] };

function makeService(): ResilienceInternals {
  const service = new McpService() as unknown as ResilienceInternals;
  service.runtime = { reportError: vi.fn() };
  return service;
}

function makeHttpConnection(): McpConnection {
  return {
    server: {
      name: "remote",
      status: "connected",
      config: JSON.stringify({ type: "streamable-http", url: "https://mcp.example.com/mcp" }),
      error: "",
    },
    client: {},
    transport: {},
  } as unknown as McpConnection;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("per-server connection containment", () => {
  it("connects the healthy server and reports the failing one instead of throwing", async () => {
    const service = makeService();
    const initialized: string[] = [];
    service.initializeConnection = vi.fn(async (name: string) => {
      if (name === "a") throw new Error("connect refused");
      initialized.push(name);
    });

    await expect(
      service.updateServerConnections({ a: STDIO_A, b: STDIO_B })
    ).resolves.toBeUndefined();

    expect(initialized).toEqual(["b"]);
    expect(service.runtime.reportError).toHaveBeenCalledTimes(1);
    expect(service.runtime.reportError).toHaveBeenCalledWith(
      "mcp.connect",
      expect.any(Error),
      expect.objectContaining({ serverName: "a" })
    );
  });

  it("marks a partially-initialized server disconnected with its error surfaced", async () => {
    const service = makeService();
    service.initializeConnection = vi.fn(async (name: string, config: McpServerConfig) => {
      service.connections.set(name, {
        server: { name, status: "connecting", config: JSON.stringify(config), error: "" },
        client: {},
        transport: {},
      } as unknown as McpConnection);
      throw new Error("handshake failed mid-connect");
    });

    await service.updateServerConnections({ a: STDIO_A });

    const partial = service.connections.get("a");
    expect(partial?.server.status).toBe("disconnected");
    expect(partial?.server.error).toContain("handshake failed mid-connect");
  });

  it("still rejects the whole update on an unsafe config (security stays fail-closed)", async () => {
    const service = makeService();
    service.initializeConnection = vi.fn(async () => {});

    await expect(
      service.updateServerConnections({
        evil: { type: "stdio", command: "rm" } as McpServerConfig,
      })
    ).rejects.toThrowError(/invalid or unsafe config/);
  });
});

describe("failed connection initialization cleanup", () => {
  it("closes the started transport and removes the partial connection and state", async () => {
    const service = makeService();
    const transport = {
      start: vi.fn(async () => {
        throw new Error("handshake failed mid-connect");
      }),
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        await transport.onclose?.();
      }),
      onclose: undefined as (() => void | Promise<void>) | undefined,
      onerror: undefined as ((error: Error) => void | Promise<void>) | undefined,
      onmessage: undefined,
    } as unknown as McpConnection["transport"] & {
      onclose?: () => void | Promise<void>;
    };
    service.buildStdioClientTransport = vi.fn(async () => transport);

    await expect(service.initializeConnection("a", STDIO_A)).rejects.toMatchObject({
      code: "MCP_SERVER_INITIALIZATION_FAILED",
      cause: expect.objectContaining({ message: "handshake failed mid-connect" }),
    });

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(service.connections.has("a")).toBe(false);
    expect(service.connectionStates.has("a")).toBe(false);
  });

  it("closes the unconnected client and clears state when transport construction fails", async () => {
    const service = makeService();
    const clientClose = vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
    service.buildStdioClientTransport = vi.fn(async () => {
      throw new Error("transport construction failed");
    });

    await expect(service.initializeConnection("a", STDIO_A)).rejects.toMatchObject({
      code: "MCP_SERVER_INITIALIZATION_FAILED",
    });

    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(service.connections.has("a")).toBe(false);
    expect(service.connectionStates.has("a")).toBe(false);
  });
});

describe("HTTP transport error tolerance", () => {
  function fireError(error: Error): McpConnection {
    const service = makeService();
    const connection = makeHttpConnection();
    service.connections.set("remote", connection);
    service.setupTransportHandlers("remote", connection, {
      status: "connected",
      reconnectAttempts: 0,
      consecutivePingFailures: 0,
    });
    const onerror = (connection.transport as { onerror?: (error: Error) => Promise<void> }).onerror;
    if (!onerror) throw new Error("onerror handler was not installed");
    void onerror(error);
    return connection;
  }

  it("keeps the connection up when the SDK identifies an SSE stream-reader disconnect", () => {
    const connection = fireError(
      new Error("SSE stream disconnected: TimeoutError: the operation timed out")
    );
    expect(connection.server.status).toBe("connected");
    expect(connection.server.error).toBe("");
  });

  it("keeps the connection up for a timeout tagged as the optional SSE GET request", () => {
    const connection = fireError(
      new ElizaError("MCP SSE stream GET request failed: request timed out", {
        code: "MCP_SSE_STREAM_REQUEST_FAILED",
        context: { method: "GET" },
        cause: new Error("request timed out"),
      })
    );
    expect(connection.server.status).toBe("connected");
    expect(connection.server.error).toBe("");
  });

  it.each([
    "TimeoutError: the operation timed out",
    "MCP HTTP POST request failed: request timeout",
    "Authentication token exchange timed out",
    "SSE error: authentication request timed out",
    "Streamable HTTP error: Error POSTing to endpoint: request timeout",
  ])("degrades the connection on an unscoped or non-stream timeout: %s", (message) => {
    const connection = fireError(new Error(message));
    expect(connection.server.status).toBe("disconnected");
    expect(connection.server.error).toContain(message);
  });

  it("still degrades the connection on a real transport error", () => {
    const connection = fireError(new Error("ECONNREFUSED 203.0.113.7:443"));
    expect(connection.server.status).toBe("disconnected");
    expect(connection.server.error).toContain("ECONNREFUSED");
  });
});
