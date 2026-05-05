import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { callToolAction } from "../src/actions/callToolAction";
import { getMcpRouteForTest, mcpRouterAction } from "../src/actions/mcpRouterAction";
import { readResourceAction } from "../src/actions/readResourceAction";
import { MCP_SERVICE_NAME } from "../src/types";

function createMessage(text: string): Memory {
  return {
    id: "message-id",
    agentId: "agent-id",
    entityId: "entity-id",
    roomId: "room-id",
    content: { text, source: "test" },
  } as unknown as Memory;
}

function createRuntime(): IAgentRuntime {
  const service = {
    getServers: vi.fn(() => [
      {
        name: "github",
        status: "connected",
        tools: [{ name: "get_file" }],
        resources: [{ uri: "repo://readme" }],
      },
    ]),
  };

  return {
    agentId: "agent-id",
    getService: vi.fn((name: string) => (name === MCP_SERVICE_NAME ? service : null)),
  } as unknown as IAgentRuntime;
}

describe("MCP router action", () => {
  it("selects tool and resource operations from text or parameters", () => {
    expect(getMcpRouteForTest(createMessage("Read the MCP docs resource"))).toBe("resource");
    expect(getMcpRouteForTest(createMessage("Use the MCP search tool"))).toBe("tool");
    expect(
      getMcpRouteForTest(createMessage("Do the MCP thing"), {
        parameters: { operation: "resource" },
      })
    ).toBe("resource");
  });

  it("validates when a connected MCP server has tools or resources", async () => {
    await expect(
      mcpRouterAction.validate(createRuntime(), createMessage("Use an MCP tool"))
    ).resolves.toBe(true);
  });

  it("delegates to the selected resource action and annotates the result", async () => {
    const handler = vi.spyOn(readResourceAction, "handler").mockResolvedValue({
      success: true,
      text: "read",
      data: { uri: "repo://readme" },
    });

    const result = await mcpRouterAction.handler(
      createRuntime(),
      createMessage("Read the MCP docs resource"),
      undefined,
      { parameters: { operation: "resource" } }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "MCP_ACTION",
        routedActionName: "READ_MCP_RESOURCE",
        operation: "resource",
        uri: "repo://readme",
      },
    });

    handler.mockRestore();
  });

  it("delegates to the selected tool action", async () => {
    const handler = vi.spyOn(callToolAction, "handler").mockResolvedValue({
      success: true,
      text: "called",
      data: { toolName: "get_file" },
    });

    const result = await mcpRouterAction.handler(
      createRuntime(),
      createMessage("Use the MCP tool"),
      undefined,
      { parameters: { operation: "tool" } }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result?.data).toMatchObject({
      actionName: "MCP_ACTION",
      routedActionName: "CALL_MCP_TOOL",
      operation: "tool",
    });

    handler.mockRestore();
  });
});
