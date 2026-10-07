/** Proves resource reads use the configured MCP request timeout over real stdio. */
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { McpService } from "../src/service";

const runtimes: AgentRuntime[] = [];
const fixture = fileURLToPath(new URL("./fixtures/paginated-server.mjs", import.meta.url));

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
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
    const started = Date.now();
    await expect(service.readResource("pages", "fixture:///slow")).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("returns a slow resource when it finishes inside the configured timeout", async () => {
    const service = await start(2000);
    const result = await service.readResource("pages", "fixture:///slow");
    expect(result.contents[0]).toMatchObject({ text: "last-page resource" });
  });

  it("disconnects when tool discovery exceeds the configured timeout", async () => {
    const service = await start(80, "slow-list");
    const [server] = service.getServers();
    expect(server?.status).toBe("disconnected");
    expect(server?.error ?? "").toMatch(/timed out/i);
  });

  it("finishes tool discovery when the list returns inside the configured timeout", async () => {
    const service = await start(2000, "slow-list");
    const [server] = service.getServers();
    expect(server?.status).toBe("connected");
    expect(server?.tools?.map((tool) => tool.name)).toContain("tool-0");
  });
});
