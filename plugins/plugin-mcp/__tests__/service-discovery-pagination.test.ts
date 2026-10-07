/** Exercises registered McpService discovery against an SDK server over real stdio. */
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpService } from "../src/service";
import { DEFAULT_PING_CONFIG } from "../src/types";

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
