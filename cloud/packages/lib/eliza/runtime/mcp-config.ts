import { elizaLogger } from "@elizaos/core";
import { getRequestContext } from "@/lib/services/entity-settings/request-context";
import type { UserContext } from "../user-context";

export const MCP_SERVER_CONFIGS: Record<string, { url: string; type: string }> = {
  google: { url: "/api/mcps/google/streamable-http", type: "streamable-http" },
  hubspot: {
    url: "/api/mcps/hubspot/streamable-http",
    type: "streamable-http",
  },
  github: { url: "/api/mcps/github/streamable-http", type: "streamable-http" },
  notion: { url: "/api/mcps/notion/streamable-http", type: "streamable-http" },
  linear: { url: "/api/mcps/linear/streamable-http", type: "streamable-http" },
  asana: { url: "/api/mcps/asana/streamable-http", type: "streamable-http" },
  dropbox: {
    url: "/api/mcps/dropbox/streamable-http",
    type: "streamable-http",
  },
  salesforce: {
    url: "/api/mcps/salesforce/streamable-http",
    type: "streamable-http",
  },
  airtable: {
    url: "/api/mcps/airtable/streamable-http",
    type: "streamable-http",
  },
  zoom: { url: "/api/mcps/zoom/streamable-http", type: "streamable-http" },
  jira: { url: "/api/mcps/jira/streamable-http", type: "streamable-http" },
  linkedin: {
    url: "/api/mcps/linkedin/streamable-http",
    type: "streamable-http",
  },
  microsoft: {
    url: "/api/mcps/microsoft/streamable-http",
    type: "streamable-http",
  },
  twitter: {
    url: "/api/mcps/twitter/streamable-http",
    type: "streamable-http",
  },
};

/**
 * Transform MCP settings by resolving relative URLs to absolute URLs.
 *
 * Auth is injected dynamically by McpService.createHttpTransport() via
 * getSetting("ELIZAOS_API_KEY"), which reads from request context.
 */
export function transformMcpSettings(
  mcpSettings: Record<string, unknown>,
): Record<string, unknown> {
  if (!mcpSettings?.servers) return mcpSettings;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const transformedServers: Record<string, unknown> = {};

  for (const [serverId, serverConfig] of Object.entries(
    mcpSettings.servers as Record<
      string,
      { url?: string; type?: string; headers?: Record<string, string> } | null
    >,
  )) {
    if (!serverConfig) continue;
    const transformedUrl = serverConfig.url?.startsWith("/")
      ? `${baseUrl}${serverConfig.url}`
      : serverConfig.url;

    transformedServers[serverId] = {
      ...serverConfig,
      url: transformedUrl,
    };
  }

  return { ...mcpSettings, servers: transformedServers };
}

export function getConnectedPlatforms(context: UserContext): Set<string> {
  return new Set((context.oauthConnections || []).map((c) => c.platform.toLowerCase()));
}

export function getConnectedMcpPlatforms(context: UserContext): string[] {
  const connected = getConnectedPlatforms(context);
  return Object.keys(MCP_SERVER_CONFIGS).filter((p) => connected.has(p));
}

export function shouldEnableMcp(context: UserContext): boolean {
  return getConnectedMcpPlatforms(context).length > 0;
}

/**
 * Set MCP_ENABLED_SERVERS in request context so dynamic-tool-actions can filter
 * tools per user on every path.
 */
export function setMcpEnabledServers(context: UserContext): void {
  const requestCtx = getRequestContext();
  if (!requestCtx) return;
  const enabledServers = getConnectedMcpPlatforms(context);
  requestCtx.entitySettings.set("MCP_ENABLED_SERVERS", JSON.stringify(enabledServers));
}

export function buildMcpSettings(context: UserContext): { mcp?: Record<string, unknown> } {
  const connected = getConnectedPlatforms(context);
  const enabledServers = Object.fromEntries(
    Object.entries(MCP_SERVER_CONFIGS).filter(([p]) => connected.has(p)),
  );

  if (Object.keys(enabledServers).length === 0) return {};

  elizaLogger.debug(`[RuntimeFactory] MCP enabled: ${Object.keys(enabledServers).join(", ")}`);

  return {
    mcp: transformMcpSettings({ servers: enabledServers }),
  };
}
