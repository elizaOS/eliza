/** Exercises registered McpService discovery against SDK servers over real stdio and HTTP. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  type AgentRuntime,
  type Content,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpAction } from "../src/actions/mcp";
import { McpService } from "../src/service";
import { DEFAULT_PING_CONFIG } from "../src/types";

const runtimes: AgentRuntime[] = [];
const fixture = fileURLToPath(new URL("./fixtures/paginated-server.mjs", import.meta.url));
const lists = ["tools", "resources", "resourceTemplates"] as const;

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

async function start(mode: string, failingList = "", peer = fixture) {
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "mcp-discovery-test",
      bio: "MCP transport regression",
      settings: {
        mcp: {
          servers: {
            pages: { type: "stdio", command: "node", args: [peer, mode, failingList] },
            ...(mode === "endless"
              ? { healthy: { type: "stdio", command: "node", args: [fixture, "single"] } }
              : {}),
          },
        },
      },
    },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  await runtime.initialize();
  await runtime.registerService(McpService);
  const service = (await runtime.getServiceLoadPromise("mcp")) as McpService;
  return { runtime, service };
}

async function receipt(service: McpService, mode: string) {
  const result =
    mode === "tools-only"
      ? (await service.callTool("pages", "tool-2")).content[0]
      : (await service.readResource("pages", "fixture:///2")).contents[0];
  if (!("text" in result) || typeof result.text !== "string") throw new Error("Expected receipt");
  return JSON.parse(result.text) as { requests: Array<{ list: string; cursor: string | null }> };
}

async function enableFastHealthChecks(service: McpService, failure?: string) {
  // Change only timer policy; public restart runs the real connection and ping path.
  Object.assign(service, {
    pingConfig: {
      ...DEFAULT_PING_CONFIG,
      intervalMs: failure === "ping-error" ? 1100 : failure ? 200 : 50,
      timeoutMs: failure === "ping-timeout" ? 100 : 1000,
    },
  });
  await service.restartConnection("pages");
}

describe("McpService declared capabilities and health", () => {
  it.each(["resources-only", "tools-only", "no-capabilities"])(
    "connects a %s peer without requesting unsupported lists",
    async (mode) => {
      const { runtime, service } = await start(mode);
      const [server] = service.getServers();
      expect(server.status).toBe("connected");
      expect(server.tools?.map((tool) => tool.name)).toEqual(
        mode === "tools-only" ? ["tool-0", "tool-2"] : []
      );
      expect(server.resources?.map((resource) => resource.uri)).toEqual(
        mode === "resources-only" ? ["fixture:///0", "fixture:///2"] : []
      );
      expect(server.resourceTemplates?.map((template) => template.name)).toEqual(
        mode === "resources-only" ? ["template-0", "template-2"] : []
      );
      expect(Object.keys(service.getProviderData().data.mcp.pages.resources)).toEqual(
        mode === "resources-only" ? ["fixture:///0", "fixture:///2"] : []
      );
      if (mode !== "no-capabilities") {
        const readback = await receipt(service, mode);
        const advertised = mode === "tools-only" ? ["tools"] : ["resources", "resourceTemplates"];
        expect(readback.requests).toEqual(
          advertised.flatMap((list) => [
            { list, cursor: null },
            { list, cursor: "" },
            { list, cursor: "page B/+=" },
          ])
        );
        console.info("MCP capability discovery receipt:", JSON.stringify({ mode, ...readback }));
      }
      expect(runtime.getRecentReportedErrors()).toEqual([]);
    }
  );

  it.each(["resources-only", "tools-only"])(
    "keeps a %s peer usable across periodic protocol pings",
    async (mode) => {
      const { runtime, service } = await start(mode);
      await enableFastHealthChecks(service);
      let readback: Awaited<ReturnType<typeof receipt>> | undefined;
      await vi.waitFor(
        async () => {
          readback = await receipt(service, mode);
          expect(
            readback.requests.filter((request) => request.list === "ping").length
          ).toBeGreaterThanOrEqual(3);
        },
        { timeout: 5000 }
      );
      expect(service.getServers()[0].status).toBe("connected");
      const lists = mode === "tools-only" ? ["tools"] : ["resources", "resourceTemplates"];
      expect(readback?.requests.filter((request) => request.list !== "ping")).toHaveLength(
        lists.length * 3
      );
      expect(runtime.getRecentReportedErrors()).toEqual([]);
      console.info("MCP capability health receipt:", JSON.stringify({ mode, ...readback }));
    }
  );

  it.each(["ping-error", "ping-timeout"])(
    "schedules reconnect for a resources-only peer after repeated %s failures",
    async (failure) => {
      const { service } = await start("resources-only", failure);
      await enableFastHealthChecks(service, failure);
      // The public server projection does not expose reconnect counters.
      const states = (
        service as unknown as {
          connectionStates: Map<
            string,
            {
              status: string;
              consecutivePingFailures: number;
              reconnectTimeout?: unknown;
              lastError?: Error;
            }
          >;
        }
      ).connectionStates;
      await vi.waitFor(
        () => {
          expect(states.get("pages")).toMatchObject({
            status: "disconnected",
            consecutivePingFailures: 3,
          });
          expect(states.get("pages")?.reconnectTimeout).toBeDefined();
        },
        { timeout: 5000 }
      );
      expect(states.get("pages")?.lastError?.message).toContain(
        failure === "ping-error" ? "ping unavailable" : "Request timed out"
      );
      await service.stop();
      expect(states.size).toBe(0);
    },
    15000
  );
});

describe("McpService paginated discovery", () => {
  it("publishes every page, crosses an empty page, and executes a last-page capability", async () => {
    const { runtime, service } = await start("pages");
    const [server] = service.getServers();
    expect(server.status).toBe("connected");
    expect(server.tools?.map((tool) => tool.name)).toEqual(["tool-0", "tool-2"]);
    expect(server.resources?.map((resource) => resource.uri)).toEqual([
      "fixture:///0",
      "fixture:///2",
    ]);
    expect(server.resourceTemplates?.map((template) => template.name)).toEqual([
      "template-0",
      "template-2",
    ]);
    const projection = service.getProviderData();
    expect(Object.keys(projection.data.mcp.pages.tools)).toEqual(["tool-0", "tool-2"]);
    expect(Object.keys(projection.data.mcp.pages.resources)).toEqual([
      "fixture:///0",
      "fixture:///2",
    ]);
    expect(projection.text).toContain("tool-2");
    expect(projection.text).toContain("fixture:///2");

    const result = await service.callTool("pages", "tool-2");
    const text = result.content[0];
    expect(text.type).toBe("text");
    if (text.type !== "text") throw new Error("Expected transport receipt");
    console.info("MCP discovery transport receipt:", text.text);
    expect(JSON.parse(text.text)).toEqual({
      tool: "tool-2",
      requests: lists.flatMap((list) => [
        { list, cursor: null },
        { list, cursor: "" },
        { list, cursor: "page B/+=" },
      ]),
    });
    expect(await service.readResource("pages", "fixture:///2")).toEqual({
      contents: [{ uri: "fixture:///2", text: "last-page resource" }],
    });
    expect(runtime.getRecentReportedErrors()).toEqual([]);
  });

  it.each(["single", "empty"])(
    "preserves %s-page discovery without issuing extra requests",
    async (mode) => {
      const { service } = await start(mode);
      const [server] = service.getServers();
      expect(server.status).toBe("connected");
      for (const list of lists) expect(server[list]).toHaveLength(mode === "single" ? 1 : 0);
      const result = await service.callTool("pages", "receipt");
      const text = result.content[0];
      if (text.type !== "text") throw new Error("Expected transport receipt");
      expect(JSON.parse(text.text).requests).toEqual(lists.map((list) => ({ list, cursor: null })));
    }
  );

  describe.each(lists)("%s failures", (list) => {
    it.each(["repeat", "cycle", "sticky-empty"])(
      "rejects a %s cursor before publishing a partial catalog",
      async (mode) => {
        const { runtime, service } = await start(mode, list);
        const [server] = service.getServers();
        expect(server.status).toBe("disconnected");
        expect(server.error).toContain("repeated a pagination cursor");
        expect(server.tools).toBeUndefined();
        expect(service.getProviderData().data.mcp.pages.tools).toEqual({});
        expect(runtime.getRecentReportedErrors()).toEqual([
          expect.objectContaining({ scope: "mcp.connect", code: "MCP_PAGINATION_CURSOR_REPEATED" }),
        ]);
      }
    );

    it("rejects an endless cursor stream without blocking service initialization", async () => {
      const { runtime, service } = await start("endless", list);
      const server = service.getServers().find((entry) => entry.name === "pages");
      expect(server?.status).toBe("disconnected");
      expect(server?.tools).toBeUndefined();
      expect(service.getServers().find((entry) => entry.name === "healthy")).toMatchObject({
        status: "connected",
        tools: [expect.objectContaining({ name: "tool-0" })],
      });
      expect(runtime.getRecentReportedErrors()).toEqual([
        expect.objectContaining({ scope: "mcp.connect", code: "MCP_PAGINATION_LIMIT_EXCEEDED" }),
      ]);
    });

    it("surfaces a later-page RPC failure instead of admitting the first page", async () => {
      const { runtime, service } = await start("error", list);
      const [server] = service.getServers();
      expect(server.status).toBe("disconnected");
      expect(server.error).toContain("later page unavailable");
      expect(server.tools).toBeUndefined();
      expect(runtime.getRecentReportedErrors()).toEqual([
        expect.objectContaining({
          scope: "mcp.connect",
          message: expect.stringContaining("later page unavailable"),
        }),
      ]);
    });
  });
});

describe("MCP binary resource persistence", () => {
  it.each(["call_tool", "read_resource"])(
    "retains exact binary resources through %s",
    async (op) => {
      const peer = fileURLToPath(new URL("./fixtures/audio-result-server.mjs", import.meta.url));
      const { runtime, service } = await start("binary", "", peer);
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () => "Fixture media response",
        "mcp-fixture",
        1000
      );
      const raw = await service.readResource("pages", "fixture:///media");
      const message: Memory = {
        id: stringToUuid(`mcp-resource-${op}`),
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: stringToUuid(`mcp-resource-room-${op}`),
        content: { text: "Read the fixture media" },
      };
      const replies: Content[] = [];
      const result = await mcpAction.handler(
        runtime,
        message,
        undefined,
        {
          parameters: {
            action: op,
            serverName: "pages",
            toolName: "sample",
            arguments: {},
            uri: "fixture:///media",
          },
        },
        async (content) => {
          replies.push(content);
          return [];
        }
      );
      expect(result).toMatchObject({ success: true });
      const attachments = replies.flatMap((reply) => reply.attachments ?? []);
      expect(attachments).toHaveLength(3);
      expect(new Set(attachments.map((item) => item.id)).size).toBe(3);
      for (const [index, original] of raw.contents.entries()) {
        expect(attachments[index]).toMatchObject({
          mimeType: original.mimeType,
          title: original.uri,
        });
        expect(attachments[index].url).toBe(`data:${original.mimeType};base64,${original.blob}`);
      }
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: op === "call_tool" ? "tools" : "resources",
        count: 10,
      });
      expect(memories).toHaveLength(1);
      expect(memories[0].content.attachments).toEqual(attachments);
    }
  );
});

describe("MCP operation without an explicit action", () => {
  it("calls the selected tool when the request text reads like a resource read", async () => {
    const peer = fileURLToPath(new URL("./fixtures/audio-result-server.mjs", import.meta.url));
    const { runtime } = await start("binary", "", peer);
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async () => "Fixture media response",
      "mcp-fixture",
      1000
    );
    const message: Memory = {
      id: stringToUuid("mcp-op-from-selection"),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: stringToUuid("mcp-op-from-selection-room"),
      content: { text: "Read the fixture media file" },
    };
    const result = await mcpAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { serverName: "pages", toolName: "sample", arguments: {} } },
      async () => []
    );
    expect(result).toMatchObject({ success: true });
    const tools = await runtime.getMemories({
      roomId: message.roomId,
      tableName: "tools",
      count: 10,
    });
    expect(tools).toHaveLength(1);
  });
});

describe("MCP resource selection through model feedback", () => {
  it.each(["fixture:///2", "fixture:///unlisted-linked-result"])(
    "repairs a missing server selection and reads %s through real stdio",
    async (uri) => {
      const peer = fileURLToPath(new URL("./fixtures/resource-result-server.mjs", import.meta.url));
      const { runtime, service } = await start("text", "", peer);
      expect(Object.keys(service.getProviderData().data.mcp.pages.resources)).toEqual([
        "fixture:///2",
      ]);
      let smallCalls = 0;
      const feedback: string[] = [];
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async () => {
          smallCalls++;
          return smallCalls === 1
            ? JSON.stringify({ serverName: "missing-peer", uri, noResourceAvailable: false })
            : "The full resource reached the action.";
        },
        "resource-selection-fixture",
        1000
      );
      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_runtime, parameters) => {
          feedback.push(parameters.prompt);
          return JSON.stringify({ serverName: "pages", uri, noResourceAvailable: false });
        },
        "resource-selection-fixture",
        1000
      );
      const message: Memory = {
        id: stringToUuid(`mcp-selection-${uri}`),
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: stringToUuid(`mcp-selection-room-${uri}`),
        content: { text: `Read the resource at ${uri} from the connected pages server.` },
      };
      const result = await mcpAction.handler(
        runtime,
        message,
        undefined,
        { parameters: { action: "read_resource" } },
        async () => []
      );
      expect(result).toMatchObject({ success: true, data: { output: "last-page resource" } });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]).toContain('Server "missing-peer" not found or not connected');
      expect(smallCalls).toBe(2);
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: "resources",
        count: 10,
      });
      expect(memories).toHaveLength(1);
      expect(memories[0].content.text).toContain("last-page resource");
    }
  );
});

describe("McpService HTTP transport recovery", () => {
  it("serves tool calls again after one failed HTTP request", async () => {
    let failNext = false;
    const httpServer = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (failNext) {
        failNext = false;
        res.writeHead(502).end("bad gateway");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const mcp = new McpServer({ name: "echo", version: "1.0.0" });
      mcp.tool("echo", async () => ({ content: [{ type: "text", text: "ok" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(body));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    try {
      const runtime = createSQLiteTestRuntime({
        character: { name: "mcp-http-test", bio: "MCP HTTP recovery regression" },
        logLevel: "fatal",
      });
      runtimes.push(runtime);
      await runtime.initialize();
      await runtime.registerService(McpService);
      const service = (await runtime.getServiceLoadPromise("mcp")) as McpService;
      // The SSRF guard rightly refuses loopback URLs, so this test builds an
      // unguarded transport to the local server and enters the service's own
      // connection path directly. Error handling and reconnect stay real.
      vi.spyOn(
        service as unknown as {
          buildHttpClientTransport(name: string, config: { url: string }): Promise<unknown>;
        },
        "buildHttpClientTransport"
      ).mockImplementation(
        async (_name, config) => new StreamableHTTPClientTransport(new URL(config.url))
      );
      await (
        service as unknown as {
          initializeConnection(name: string, config: Record<string, string>): Promise<void>;
        }
      ).initializeConnection("remote", {
        type: "streamable-http",
        url: `http://127.0.0.1:${port}/mcp`,
      });
      expect((await service.callTool("remote", "echo")).content[0]).toMatchObject({ text: "ok" });

      failNext = true;
      await expect(service.callTool("remote", "echo")).rejects.toThrow();

      // The server is healthy again; the service must reconnect on its own.
      await vi.waitFor(
        async () => {
          expect((await service.callTool("remote", "echo")).content[0]).toMatchObject({
            text: "ok",
          });
        },
        { timeout: 10_000, interval: 250 }
      );
    } finally {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 30_000);
});
