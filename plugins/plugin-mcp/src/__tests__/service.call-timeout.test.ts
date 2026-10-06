import { describe, expect, it, vi } from "vitest";
import { McpService } from "../service";
import type { McpConnection, McpServerConfig } from "../types";

function serviceFor(config: McpServerConfig) {
  const callTool = vi.fn().mockResolvedValue({ content: [] });
  const connection = {
    client: { callTool },
    server: { config: JSON.stringify(config), disabled: false },
  } as unknown as McpConnection;
  const service = new McpService();
  Object.defineProperty(service, "connections", {
    value: new Map([["example", connection]]),
  });
  return { service, callTool };
}

describe("McpService tool-call timeout", () => {
  it("uses the configured timeout for HTTP servers", async () => {
    const { service, callTool } = serviceFor({
      type: "streamable-http",
      url: "https://mcp.example.test",
      timeout: 2500,
    });

    await service.callTool("example", "lookup");

    expect(callTool).toHaveBeenCalledWith({ name: "lookup", arguments: undefined }, undefined, {
      timeout: 2500,
    });
  });

  it("keeps the configured timeout for stdio servers", async () => {
    const { service, callTool } = serviceFor({
      type: "stdio",
      command: "mcp-server",
      timeoutInMillis: 3500,
    });

    await service.callTool("example", "lookup");

    expect(callTool).toHaveBeenCalledWith({ name: "lookup", arguments: undefined }, undefined, {
      timeout: 3500,
    });
  });
});
