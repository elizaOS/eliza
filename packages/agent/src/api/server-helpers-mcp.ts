/**
 * MCP server configuration validation helpers extracted from server.ts.
 */

import type http from "node:http";
import { validateMcpServerConfig } from "@elizaos/core";

import { hasBlockedObjectKeyDeep } from "./blocked-object-keys.ts";

import {
  resolveTerminalRunRejection,
  type TerminalRunRejection,
} from "./server-helpers-auth.ts";

import { isBlockedObjectKey } from "./server-helpers-config.ts";

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
 * Stdio MCP config writes can reach child_process.spawn, so they require
 * ELIZA_TERMINAL_RUN_TOKEN.
 */
export function resolveMcpTerminalAuthorizationRejection(
  req: Pick<http.IncomingMessage, "headers">,
  servers: Record<string, unknown>,
  body: { terminalToken?: string },
): TerminalRunRejection | null {
  if (!mcpServersIncludeStdio(servers)) {
    return null;
  }

  const expected = process.env.ELIZA_TERMINAL_RUN_TOKEN?.trim();
  if (!expected) {
    return {
      status: 403,
      reason:
        "Stdio MCP server configuration requires ELIZA_TERMINAL_RUN_TOKEN.",
    };
  }

  return resolveTerminalRunRejection(req as http.IncomingMessage, body);
}
