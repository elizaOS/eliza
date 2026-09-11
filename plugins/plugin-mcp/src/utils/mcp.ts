/**
 * Provider-data assembly and memory persistence for MCP: buildMcpProviderData
 * turns the connected-server list into the provider's structured data plus a
 * markdown summary, and createMcpMemory records tool/resource use as an agent
 * memory with an embedding when the runtime provides that capability.
 */
import { type IAgentRuntime, type Memory, ModelType } from "@elizaos/core";
import { buildMcpProviderProjection } from "@elizaos/shared/mcp";
import type { McpProvider, McpServer } from "../types";

export async function createMcpMemory(
  runtime: IAgentRuntime,
  message: Memory,
  type: "tool" | "resource",
  serverName: string,
  content: string,
  metadata: Readonly<Record<string, unknown>>
): Promise<void> {
  const memory: Memory = {
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
  };

  const persistedMemory = runtime.getModel(ModelType.TEXT_EMBEDDING)
    ? await runtime.addEmbeddingToMemory(memory)
    : memory;

  await runtime.createMemory(persistedMemory, type === "resource" ? "resources" : "tools", true);
}

export function buildMcpProviderData(servers: readonly McpServer[]): McpProvider {
  return buildMcpProviderProjection(servers) as McpProvider;
}
