import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { McpService } from "./service";
import { MCP_SERVICE_NAME } from "./types";

export const provider: Provider = {
  name: "MCP",
  description: "Information about connected MCP servers, tools, and resources",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!mcpService) {
      return {
        values: {},
        data: {},
        text: "No MCP servers are available.",
      };
    }

    const providerData = mcpService.getProviderData();
    return {
      values: { mcpServers: JSON.stringify(providerData.values.mcp) },
      data: { mcpServerCount: Object.keys(providerData.data.mcp).length },
      text: providerData.text,
    };
  },
};
