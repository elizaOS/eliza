/** Proves resource reads use the configured MCP request timeout over real stdio. */
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpService } from "../src/service";

const runtimes: AgentRuntime[] = [];
const fixture = fileURLToPath(new URL("./fixtures/paginated-server.mjs", import.meta.url));

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
  } finally {
    vi.restoreAllMocks();
  }
});

async function start(timeoutInMillis: number, mode = "slow-read") {
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "mcp-resource-timeout",
      bio: "MCP resource timeout regression",
      settings: {
        mcp: {
          servers: {
            pages: {
              type: "stdio",
              command: "node",
              args: [fixture, mode],
              timeoutInMillis,
            },
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
  return service;
}

describe("McpService resource read timeout", () => {
  it("aborts a slow resource read at the configured stdio timeout", async () => {
    const service = await start(80);
    await expect(service.readResource("pages", "fixture:///slow")).rejects.toMatchObject({
      code: ErrorCode.RequestTimeout,
    });
  });

  it("returns a slow resource when it finishes inside the configured timeout", async () => {
    const service = await start(2000);
    const result = await service.readResource("pages", "fixture:///slow");
    expect(result.contents[0]).toMatchObject({ text: "last-page resource" });
  });

  it("disconnects when tool discovery exceeds the configured timeout", async () => {
    const ownedPids: number[] = [];
    const originalStart = StdioClientTransport.prototype.start;
    vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(async function (
      this: StdioClientTransport
    ) {
      await originalStart.call(this);
      if (this.pid !== null) ownedPids.push(this.pid);
    });
    const service = await start(80, "slow-list");
    const [server] = service.getServers();
    expect(server?.status).toBe("disconnected");
    expect(server?.error ?? "").toMatch(/timed out/i);
    expect(ownedPids).toHaveLength(1);
    expect(() => process.kill(ownedPids[0]!, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
    // The visible failed entry retains its config, so an operator can retry it.
    await expect(service.restartConnection("pages")).rejects.toMatchObject({
      code: ErrorCode.RequestTimeout,
    });
    expect(ownedPids).toHaveLength(2);
    expect(() => process.kill(ownedPids[1]!, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
    expect(service.getServers()[0]).toMatchObject({ status: "disconnected" });
    expect(service.getServers()[0]?.error).toMatch(/timed out/i);
  });

  it("retries when a stdio server exits during tool discovery", async () => {
    const starts: number[] = [];
    const originalStart = StdioClientTransport.prototype.start;
    vi.spyOn(StdioClientTransport.prototype, "start").mockImplementation(async function (
      this: StdioClientTransport
    ) {
      await originalStart.call(this);
      starts.push(this.pid ?? -1);
    });
    const service = await start(5000, "crash-list");
    expect(service.getServers()[0]).toMatchObject({ status: "disconnected" });
    expect(starts).toHaveLength(1);
    await vi.waitFor(() => expect(starts).toHaveLength(2), { timeout: 5000, interval: 50 });
    expect(service.getServers()[0]?.name).toBe("pages");
  });

  it("finishes tool discovery when the list returns inside the configured timeout", async () => {
    const service = await start(2000, "slow-list");
    const [server] = service.getServers();
    expect(server?.status).toBe("connected");
    expect(server?.tools?.map((tool) => tool.name)).toContain("tool-0");
  });
});
