/**
 * Builds hosted MCP provider context and enforces the per-request OAuth server
 * allowlist before Cloud tools or resources become planner-visible.
 */
import { type IAgentRuntime, logger, type Memory } from "@elizaos/core";
import { buildMcpProviderProjection } from "@elizaos/shared/mcp";
import type { McpProvider, McpServer } from "../types";

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
  return buildMcpProviderProjection(servers) as McpProvider;
}
