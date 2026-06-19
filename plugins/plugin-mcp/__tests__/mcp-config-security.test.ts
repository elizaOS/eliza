import { validateMcpServerConfig } from "@elizaos/security/mcp-server-config";
import { describe, expect, it } from "vitest";

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
});
