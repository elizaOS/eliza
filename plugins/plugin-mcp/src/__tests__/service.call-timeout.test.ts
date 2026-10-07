import { describe, expect, it, vi } from "vitest";
import { McpService } from "../service";
import type { McpConnection, McpServerConfig } from "../types";

function serviceFor(config: McpServerConfig) {
  const callTool = vi.fn().mockResolvedValue({ content: [] });
  const readResource = vi.fn().mockResolvedValue({ contents: [] });
  const connection = {
    client: { callTool, readResource },
    server: { config: JSON.stringify(config), disabled: false },
  } as unknown as McpConnection;
  const service = new McpService();
  Object.defineProperty(service, "connections", {
    value: new Map([["example", connection]]),
  });
  return { service, callTool, readResource };
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

  it("passes the stdio timeout to resource reads", async () => {
    const { service, readResource } = serviceFor({
      type: "stdio",
      command: "mcp-server",
      timeoutInMillis: 80,
    });

    await service.readResource("example", "fixture:///slow");

    expect(readResource).toHaveBeenCalledWith({ uri: "fixture:///slow" }, { timeout: 80 });
  });

  it("passes the HTTP timeout to resource reads", async () => {
    const { service, readResource } = serviceFor({
      type: "streamable-http",
      url: "https://mcp.example.test",
      timeout: 2500,
    });

    await service.readResource("example", "fixture:///doc");

    expect(readResource).toHaveBeenCalledWith({ uri: "fixture:///doc" }, { timeout: 2500 });
  });
});
