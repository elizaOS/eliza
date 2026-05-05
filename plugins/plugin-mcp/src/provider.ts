import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { McpService } from "./service";
import type { McpProviderData } from "./types";
import { MCP_SERVICE_NAME } from "./types";

function formatMcpServersForPrompt(mcp: McpProviderData): string {
  const entries = Object.entries(mcp);
  if (entries.length === 0) return "No MCP servers are available.";

  return [
    `mcpServers[${entries.length}]:`,
    ...entries.flatMap(([serverName, server]) => {
      const tools = Object.keys(server.tools ?? {});
      const resources = Object.keys(server.resources ?? {});
      return [
        `  - name: ${serverName}`,
        `    status: ${server.status}`,
        `    tools: ${tools.length > 0 ? tools.join(", ") : "none"}`,
        `    resources: ${resources.length > 0 ? resources.join(", ") : "none"}`,
      ];
    }),
  ].join("\n");
}

export const provider: Provider = {
  name: "MCP",
  description: "Information about connected MCP servers, tools, and resources",

  dynamic: true,
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
      values: { mcpServers: formatMcpServersForPrompt(providerData.values.mcp) },
      data: { mcpServerCount: Object.keys(providerData.data.mcp).length },
      text: providerData.text,
    };
  },
};
