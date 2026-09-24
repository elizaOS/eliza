/**
 * MCP provider: injects a compact summary of connected servers, their status,
 * tools, and resources into agent context each turn. Reads McpService provider
 * data without dropping any discovered server, tool, or resource.
 */
import { MCP_SERVICE_NAME } from "./types";
import { formatMcpProviderForPrompt } from "@elizaos/shared";
import { type IAgentRuntime } from "@elizaos/core";
import { type McpService } from "./service";
import { type Memory } from "@elizaos/core";
import { type Provider } from "@elizaos/core";
import { type ProviderResult } from "@elizaos/core";
import { type State } from "@elizaos/core";
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
            const serverEntries = Object.entries(providerData.data.mcp);
            const text = formatMcpProviderForPrompt(mcp);
            return {
                values: { mcpServers: text },
                data: {
                    mcpServerCount: Object.keys(providerData.data.mcp).length,
                    shownMcpServerCount: serverEntries.length,
                },
                text,
            };
        }
        catch (error) {
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
