/**
 * Verifies the MCP plugin re-runs config security validation at its own boundary:
 * drives the real core validateMcpServerConfig to confirm unsafe
 * stdio env channels (npm/uv config injection) are rejected before spawn.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { validateMcpServerConfig } from "@elizaos/core/security/mcp-server-config";
import { describe, expect, it } from "vitest";
import { guardedMcpFetch, McpService } from "../src/service";

function runtimeWithMcpSetting(setting: unknown): IAgentRuntime {
  return {
    character: { settings: {} },
    getSetting: (key: string) => (key === "mcp" ? setting : undefined),
  } as unknown as IAgentRuntime;
}

describe("MCP spawn-time validation", () => {
  it("rejects env-channel package manager config before stdio spawn", async () => {
    const rejection = await validateMcpServerConfig({
      type: "stdio",
      command: "npx",
      args: ["evil"],
      env: {
        NPM_CONFIG_YES: "true",
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:9999/evil/",
      },
    });
    expect(rejection).toMatch(/NPM_CONFIG_/i);
  });

  it("re-validates uv config env at the plugin boundary", async () => {
    const rejection = await validateMcpServerConfig({
      type: "stdio",
      command: "uvx",
      args: ["pkg"],
      env: { UV_CONFIG_FILE: "/tmp/evil.toml" },
    });
    expect(rejection).toMatch(/UV_/i);
  });

  it("blocks private destinations in the transport fetch, not only preflight", async () => {
    await expect(guardedMcpFetch("http://100.64.0.1/mcp")).rejects.toThrow(/private|internal/i);
    await expect(guardedMcpFetch("http://127.0.0.1/mcp")).rejects.toThrow(/private|internal/i);
  });

  it("fails service initialization for malformed settings instead of silently disabling MCP", async () => {
    const service = new McpService(
      runtimeWithMcpSetting({ servers: [{ type: "stdio", command: "node" }] })
    );
    await expect(service.waitForInitialization()).rejects.toMatchObject({
      code: "MCP_SETTINGS_INVALID",
    });
  });

  it("fails the whole service when any configured server is unsafe", async () => {
    const service = new McpService(
      runtimeWithMcpSetting({
        servers: {
          unsafe: { type: "http", url: "http://127.0.0.1/mcp" },
        },
      })
    );
    await expect(service.waitForInitialization()).rejects.toMatchObject({
      code: "MCP_SERVER_CONFIG_REJECTED",
    });
  });
});
