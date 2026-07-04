/**
 * MCP provider: injects a compact summary of connected servers, their status,
 * tools, and resources into agent context each turn. Reads McpService provider
 * data and caps servers/tools/resources per turn to bound prompt size.
 */
import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { McpService } from "./service";
import type { McpProviderData } from "./types";
import { MCP_SERVICE_NAME } from "./types";

const MAX_MCP_SERVERS_IN_STATE = 20;
const MAX_MCP_TOOLS_PER_SERVER = 30;
const MAX_MCP_RESOURCES_PER_SERVER = 30;

function formatMcpServersForPrompt(mcp: McpProviderData): string {
  const entries = Object.entries(mcp).slice(0, MAX_MCP_SERVERS_IN_STATE);
  if (entries.length === 0) return "No MCP servers are available.";

  return [
    `mcpServers[${Object.keys(mcp).length}, showing ${entries.length}]:`,
    ...entries.flatMap(([serverName, server]) => {
      const tools = Object.keys(server.tools ?? {}).slice(0, MAX_MCP_TOOLS_PER_SERVER);
      const resources = Object.keys(server.resources ?? {}).slice(0, MAX_MCP_RESOURCES_PER_SERVER);
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
  contexts: ["connectors", "settings"],
  contextGate: { anyOf: ["connectors", "settings"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!mcpService) {
      return {
        values: {},
        data: {},
        text: "No MCP servers are available.",
      };
    }

    try {
      const providerData = mcpService.getProviderData();
      const mcp = providerData.values.mcp;
      const serverEntries = Object.entries(providerData.data.mcp).slice(
        0,
        MAX_MCP_SERVERS_IN_STATE
      );
      return {
        values: { mcpServers: formatMcpServersForPrompt(mcp) },
        data: {
          mcpServerCount: Object.keys(providerData.data.mcp).length,
          shownMcpServerCount: serverEntries.length,
        },
        text: formatMcpServersForPrompt(mcp),
      };
    } catch (error) {
      // error-policy:J4 explicit degrade — a McpService read failure must not
      // masquerade as the designed "No MCP servers are available." empty
      // state: the planner would treat a broken MCP subsystem as a clean
      // no-servers world. Render a distinguishable error line and surface the
      // failure via reportError (RECENT_ERRORS / owner-escalation).
      runtime.reportError?.("MCP.provider", error);
      const message = error instanceof Error ? error.message : String(error);
      const text = `MCP server status is unavailable (error reading MCP state: ${message}).`;
      return {
        values: { mcpServers: text },
        data: { error: message },
        text,
      };
    }
  },
};
