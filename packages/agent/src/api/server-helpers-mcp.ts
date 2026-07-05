/**
 * MCP server configuration validation helpers extracted from server.ts.
 */

import type http from "node:http";
import { readAliasedEnv } from "@elizaos/shared";
import { validateMcpServerConfig } from "../security/mcp-server-config.ts";
import { hasBlockedObjectKeyDeep } from "./server-helpers.ts";
import type { TerminalRunRejection } from "./server-helpers-auth.ts";
import { resolveTerminalRunRejection } from "./server-helpers-auth.ts";
import { isBlockedObjectKey } from "./server-helpers-config.ts";

export { validateMcpServerConfig } from "../security/mcp-server-config.ts";

export async function resolveMcpServersRejection(
  servers: Record<string, unknown>,
): Promise<string | null> {
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (isBlockedObjectKey(serverName)) {
      return `Invalid server name: "${serverName}"`;
    }
    if (
      !serverConfig ||
      typeof serverConfig !== "object" ||
      Array.isArray(serverConfig)
    ) {
      return `Server "${serverName}" config must be a JSON object`;
    }
    if (hasBlockedObjectKeyDeep(serverConfig)) {
      return `Server "${serverName}" contains blocked object keys`;
    }
    const configError = await validateMcpServerConfig(
      serverConfig as Record<string, unknown>,
    );
    if (configError) {
      return `Server "${serverName}": ${configError}`;
    }
  }
  return null;
}

export function mcpServersIncludeStdio(
  servers: Record<string, unknown>,
): boolean {
  return Object.values(servers).some((serverConfig) => {
    if (
      !serverConfig ||
      typeof serverConfig !== "object" ||
      Array.isArray(serverConfig)
    ) {
      return false;
    }
    return (serverConfig as Record<string, unknown>).type === "stdio";
  });
}

/**
 * Stdio MCP config writes can reach child_process.spawn. By default require
 * ELIZA_TERMINAL_RUN_TOKEN; set ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP=1 only
 * for intentional local dev (legacy compat passthrough).
 */
export function resolveMcpTerminalAuthorizationRejection(
  req: Pick<http.IncomingMessage, "headers">,
  servers: Record<string, unknown>,
  body: { terminalToken?: string },
): TerminalRunRejection | null {
  if (!mcpServersIncludeStdio(servers)) {
    return null;
  }

  if (process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP === "1") {
    return resolveTerminalRunRejection(req as http.IncomingMessage, body);
  }

  const expected = readAliasedEnv("ELIZA_TERMINAL_RUN_TOKEN");
  if (!expected) {
    return {
      status: 403,
      reason:
        "Stdio MCP server configuration requires ELIZA_TERMINAL_RUN_TOKEN. " +
        "Set ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP=1 only for intentional local development.",
    };
  }

  return resolveTerminalRunRejection(req as http.IncomingMessage, body);
}
