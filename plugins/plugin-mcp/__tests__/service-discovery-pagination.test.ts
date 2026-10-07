/** Exercises registered McpService discovery against an SDK server over real stdio. */
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { McpService } from "../src/service";
import type { ConnectionState, PingConfig } from "../src/types";

const runtimes: AgentRuntime[] = [];
const fixture = fileURLToPath(new URL("./fixtures/paginated-server.mjs", import.meta.url));
const lists = ["tools", "resources", "resourceTemplates"] as const;

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

async function start(mode: string, failingList = "") {
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "mcp-discovery-test",
      bio: "MCP transport regression",
      settings: {
        mcp: {
          servers: {
            pages: { type: "stdio", command: "node", args: [fixture, mode, failingList] },
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

describe("McpService paginated discovery", () => {
  it("keeps a resources-only peer readable through repeated protocol heartbeats", async () => {
    const { runtime, service } = await start("resources-only");
    expect(service.getServers()[0]).toMatchObject({
      status: "connected",
      tools: [],
      resources: [{ uri: "fixture:///0" }, { uri: "fixture:///2" }],
      resourceTemplates: [{ name: "template-0" }, { name: "template-2" }],
    });
    const heartbeat = service as unknown as {
      pingConfig: PingConfig;
      startPingMonitoring(name: string): void;
      connectionStates: Map<string, ConnectionState>;
    };
    heartbeat.pingConfig = {
      enabled: true,
      intervalMs: 30,
      timeoutMs: 1000,
      failuresBeforeDisconnect: 2,
    };
    heartbeat.startPingMonitoring("pages");
    let requests: { method?: string; list?: string; cursor?: string | null }[] = [];
    await expect
      .poll(async () => {
        const result = await service.readResource("pages", "fixture:///2");
        const content = result.contents[0];
        if (!("text" in content)) throw new Error("Expected resource readback");
        requests = JSON.parse(content.text);
        return requests.filter((request) => request.method === "ping").length;
      })
      .toBeGreaterThanOrEqual(3);
    expect(requests.filter((request) => request.list)).toEqual(
      lists
        .filter((list) => list !== "tools")
        .flatMap((list) => [
          { list, cursor: null },
          { list, cursor: "" },
          { list, cursor: "page B/+=" },
        ])
    );
    expect(heartbeat.connectionStates.get("pages")).toMatchObject({
      status: "connected",
      consecutivePingFailures: 0,
      reconnectAttempts: 0,
    });
    expect(service.getProviderData().data.mcp.pages.resources["fixture:///2"]).toBeDefined();
    expect(runtime.getRecentReportedErrors()).toEqual([]);
    console.info("Resources-only MCP heartbeat receipt:", JSON.stringify(requests));
  });

  it.each(["error", "timeout"])(
    "disconnects a resources-only peer after repeated ping %s",
    async (failure) => {
      const { service } = await start(`resources-only-ping-${failure}`);
      expect(service.getServers()[0].status).toBe("connected");
      const heartbeat = service as unknown as {
        pingConfig: PingConfig;
        startPingMonitoring(name: string): void;
        connectionStates: Map<string, ConnectionState>;
      };
      heartbeat.pingConfig = {
        enabled: true,
        intervalMs: failure === "error" ? 1100 : 200,
        timeoutMs: failure === "error" ? 1000 : 100,
        failuresBeforeDisconnect: 2,
      };
      heartbeat.startPingMonitoring("pages");
      await expect
        .poll(() => heartbeat.connectionStates.get("pages")?.status, { timeout: 5000 })
        .toBe("disconnected");
      const state = heartbeat.connectionStates.get("pages");
      expect(state?.consecutivePingFailures).toBe(2);
      expect(state?.lastError?.message).toContain(
        failure === "error" ? "fixture ping failed" : "Request timed out"
      );
      await service.stop();
      expect(heartbeat.connectionStates.size).toBe(0);
    },
    15000
  );

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
      const [server] = service.getServers();
      expect(server.status).toBe("disconnected");
      expect(server.tools).toBeUndefined();
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
