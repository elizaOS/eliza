/**
 * Tests McpService failure containment: one server's connection failure must not
 * abort sibling connections or fail service start, and benign HTTP stream
 * timeout/disconnect noise must not tear down a working connection.
 * Deterministic unit harness — real service instances with stubbed
 * connection internals.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { McpService } from "../src/service";
import type { McpConnection, McpServerConfig } from "../src/types";

type ResilienceInternals = {
  runtime: { reportError: ReturnType<typeof vi.fn> };
  connections: Map<string, McpConnection>;
  connectionStates: Map<string, unknown>;
  initializeConnection: (name: string, config: McpServerConfig) => Promise<void>;
  updateServerConnections: (configs: Record<string, McpServerConfig>) => Promise<void>;
  setupTransportHandlers: (name: string, connection: McpConnection, state: unknown) => void;
};

type ToolListInternals = {
  runtime: IAgentRuntime;
  connections: Map<string, McpConnection>;
  compatibilityInitialized: boolean;
  applyToolCompatibility: (schema: Record<string, unknown>) => Record<string, unknown>;
  fetchToolsList: (
    serverName: string
  ) => Promise<Array<{ name: string; inputSchema?: Record<string, unknown> }>>;
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

describe("HTTP transport error tolerance", () => {
  function fireError(message: string): McpConnection {
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
    void onerror(new Error(message));
    return connection;
  }

  it.each([
    "SSE error: TypeError: terminated",
    "SSE stream disconnected: network flakiness",
    "Streamable HTTP error: request timeout",
    "TimeoutError: The operation TIMED OUT",
  ])("keeps the connection up on benign stream noise: %s", (message) => {
    const connection = fireError(message);
    expect(connection.server.status).toBe("connected");
    expect(connection.server.error).toBe("");
  });

  it("still degrades the connection on a real transport error", () => {
    const connection = fireError("ECONNREFUSED 203.0.113.7:443");
    expect(connection.server.status).toBe("disconnected");
    expect(connection.server.error).toContain("ECONNREFUSED");
  });
});

describe("tool schema failure containment", () => {
  function makeToolService(
    tools: unknown[],
    modelProvider = "google/gemini-pro"
  ): ToolListInternals {
    const service = new McpService() as unknown as ToolListInternals;
    service.runtime = {
      character: { settings: { MODEL_PROVIDER: modelProvider } },
    } as unknown as IAgentRuntime;
    service.connections.set("remote", {
      server: { name: "remote", status: "connected", config: "{}", error: "" },
      client: { listTools: vi.fn(async () => ({ tools })) },
      transport: {},
    } as unknown as McpConnection);
    return service;
  }

  it("omits one cyclic schema while retaining and transforming its healthy sibling", async () => {
    const cyclic: Record<string, unknown> = { type: "array" };
    cyclic.items = cyclic;
    const service = makeToolService([
      { name: "hostile", inputSchema: cyclic },
      {
        name: "healthy",
        inputSchema: {
          type: "object",
          properties: { tags: { type: "array", maxItems: 4, items: { type: "string" } } },
        },
      },
    ]);

    const tools = await service.fetchToolsList("remote");
    expect(tools.map((tool) => tool.name)).toEqual(["healthy"]);
    expect(tools[0]?.inputSchema).toMatchObject({
      properties: {
        tags: { description: expect.stringContaining("4") },
      },
    });
  });

  it("rethrows an unexpected compatibility failure", async () => {
    const service = makeToolService([{ name: "tool", inputSchema: { type: "object" } }]);
    service.compatibilityInitialized = true;
    service.applyToolCompatibility = () => {
      throw new TypeError("compatibility regression");
    };

    await expect(service.fetchToolsList("remote")).rejects.toThrow("compatibility regression");
  });

  it("omits a schema whose provider rewrite expands past the retained byte cap", async () => {
    const service = makeToolService([
      { name: "expanded", inputSchema: { type: "string", pattern: "x".repeat(262_055) } },
      { name: "healthy", inputSchema: { type: "object" } },
    ]);

    await expect(service.fetchToolsList("remote")).resolves.toEqual([
      expect.objectContaining({ name: "healthy" }),
    ]);
  });

  it.each(["openai/gpt-5", "openrouter/auto"])(
    "omits an unbounded schema even when %s needs no compatibility rewrite",
    async (modelProvider) => {
      const cyclic: Record<string, unknown> = { type: "array" };
      cyclic.items = cyclic;
      const service = makeToolService(
        [
          { name: "hostile", inputSchema: cyclic },
          { name: "healthy", inputSchema: { type: "object" } },
        ],
        modelProvider
      );

      await expect(service.fetchToolsList("remote")).resolves.toEqual([
        expect.objectContaining({ name: "healthy" }),
      ]);
    }
  );
});
