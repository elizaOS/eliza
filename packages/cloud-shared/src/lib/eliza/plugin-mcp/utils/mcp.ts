import { type IAgentRuntime, logger, type Memory } from "@elizaos/core";
import type {
  McpProvider,
  McpProviderData,
  McpResourceInfo,
  McpServer,
  McpToolInfo,
} from "../types";

/**
 * Checks MCP_ENABLED_SERVERS request-context setting for per-user OAuth gating.
 * Returns true if access is allowed, false if denied.
 * When not set (CLI / non-cloud), returns true (fail-open by design).
 */
export function checkMcpOAuthAccess(runtime: IAgentRuntime, serverName?: string): boolean {
  const raw = runtime.getSetting("MCP_ENABLED_SERVERS");
  if (typeof raw !== "string") return true; // not set → fail-open

  let enabled: unknown;
  try {
    enabled = JSON.parse(raw);
  } catch {
    logger.warn({ serverName, raw }, "[MCP] Malformed MCP_ENABLED_SERVERS JSON, denying access");
    return false;
  }

  if (!Array.isArray(enabled)) {
    logger.warn({ serverName, raw }, "[MCP] MCP_ENABLED_SERVERS is not an array, denying access");
    return false;
  }

  // When no serverName given, just check the user has any enabled servers
  if (!serverName) {
    return enabled.length > 0;
  }

  if (!enabled.includes(serverName)) {
    logger.debug(
      { serverName, enabled },
      "[MCP] OAuth check denied: server not in MCP_ENABLED_SERVERS",
    );
    return false;
  }

  return true;
}

const NO_DESC = "No description";

export async function createMcpMemory(
  runtime: IAgentRuntime,
  message: Memory,
  type: string,
  serverName: string,
  content: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const memory = await runtime.addEmbeddingToMemory({
    entityId: message.entityId,
    agentId: runtime.agentId,
    roomId: message.roomId,
    content: {
      text: `Used "${type}" from "${serverName}". Content: ${content}`,
      metadata: { ...metadata, serverName },
    },
  });
  await runtime.createMemory(memory, type === "resource" ? "resources" : "tools", true);
}

export function buildMcpProviderData(servers: McpServer[]): McpProvider {
  if (servers.length === 0) {
    return {
      values: { mcp: {} },
      data: { mcp: {} },
      text: "No MCP servers connected.",
    };
  }

  const mcpData: McpProviderData = {};
  const lines: string[] = ["# MCP Configuration\n"];

  for (const server of servers) {
    const tools: Record<string, McpToolInfo> = {};
    const resources: Record<string, McpResourceInfo> = {};

    lines.push(`## ${server.name} (${server.status})\n`);

    if (server.tools?.length) {
      lines.push("### Tools\n");
      for (const t of server.tools) {
        tools[t.name] = {
          description: t.description || NO_DESC,
          inputSchema: t.inputSchema || {},
        };
        lines.push(`- **${t.name}**: ${t.description || NO_DESC}`);
      }
      lines.push("");
    }

    if (server.resources?.length) {
      lines.push("### Resources\n");
      for (const r of server.resources) {
        resources[r.uri] = {
          name: r.name,
          description: r.description || NO_DESC,
          mimeType: r.mimeType,
        };
        lines.push(`- **${r.name}** (${r.uri}): ${r.description || NO_DESC}`);
      }
      lines.push("");
    }

    mcpData[server.name] = { status: server.status, tools, resources };
  }

  const text = lines.join("\n");
  return {
    values: { mcp: mcpData, mcpText: text },
    data: { mcp: mcpData },
    text,
  };
}
