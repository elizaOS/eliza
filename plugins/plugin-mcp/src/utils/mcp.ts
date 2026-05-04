import type { IAgentRuntime, Memory } from "@elizaos/core";
import type {
  McpProvider,
  McpProviderData,
  McpResourceInfo,
  McpServer,
  McpToolInfo,
  McpToolInputSchema,
} from "../types";

export async function createMcpMemory(
  runtime: IAgentRuntime,
  message: Memory,
  type: "tool" | "resource",
  serverName: string,
  content: string,
  metadata: Readonly<Record<string, unknown>>
): Promise<void> {
  const memory = await runtime.addEmbeddingToMemory({
    entityId: message.entityId,
    agentId: runtime.agentId,
    roomId: message.roomId,
    content: {
      text: `Used the "${type}" from "${serverName}" server. 
        Content: ${content}`,
      metadata: {
        ...metadata,
        serverName,
      },
    },
  });

  await runtime.createMemory(memory, type === "resource" ? "resources" : "tools", true);
}

export function buildMcpProviderData(servers: readonly McpServer[]): McpProvider {
  const mcpData: Record<string, McpProviderData[string]> = {};
  let textContent = "";

  if (servers.length === 0) {
    return {
      values: { mcp: {} },
      data: { mcp: {} },
      text: "No MCP servers are currently connected.",
    };
  }

  for (const server of servers) {
    const tools: Record<string, McpToolInfo> = {};
    const resources: Record<string, McpResourceInfo> = {};

    mcpData[server.name] = {
      status: server.status,
      tools,
      resources,
    };

    textContent += `## Server: ${server.name} (${server.status})\n\n`;

    if (server.tools && server.tools.length > 0) {
      textContent += "### Tools:\n\n";

      for (const tool of server.tools) {
        tools[tool.name] = {
          description: tool.description ?? "No description available",
          inputSchema: tool.inputSchema as McpToolInputSchema | undefined,
        };

        textContent += `- **${tool.name}**: ${tool.description ?? "No description available"}\n`;
      }
      textContent += "\n";
    }

    if (server.resources && server.resources.length > 0) {
      textContent += "### Resources:\n\n";

      for (const resource of server.resources) {
        resources[resource.uri] = {
          name: resource.name,
          description: resource.description ?? "No description available",
          mimeType: resource.mimeType,
        };

        textContent += `- **${resource.name}** (${resource.uri}): ${
          resource.description ?? "No description available"
        }\n`;
      }
      textContent += "\n";
    }
  }

  return {
    values: { mcp: mcpData, mcpText: `# MCP Configuration\n\n${textContent}` },
    data: { mcp: mcpData },
    text: `# MCP Configuration\n\n${textContent}`,
  };
}
