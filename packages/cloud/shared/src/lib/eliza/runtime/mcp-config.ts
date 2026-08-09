// Wires hosted Eliza agent mcp config behavior for cloud runtime services.
import { elizaLogger } from "@elizaos/core";
import { GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES } from "@elizaos/shared/contracts";
import { getRequestContext } from "../../services/entity-settings/request-context";
import type { UserContext } from "../user-context";

export const MCP_SERVER_CONFIGS: Record<string, { url: string; type: string }> = {
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

const GOOGLE_MCP_PRODUCT_CAPABILITIES = Object.fromEntries(
  Object.entries(GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES).map(([product, config]) => [
    product,
    config.capability,
  ]),
) as Readonly<Record<string, string>>;

function googleBindingServers(context: UserContext): Record<string, { url: string; type: string }> {
  if (!context.characterId) return {};
  const servers: Record<string, { url: string; type: string }> = {};
  const rolePriority = { OWNER: 0, AGENT: 1, TEAM: 2 } as const;
  const priorityForRole = (role: string): number =>
    rolePriority[role as keyof typeof rolePriority] ?? Number.MAX_SAFE_INTEGER;
  const bindings = [...(context.connectorBindings ?? [])].sort(
    (left, right) =>
      Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) ||
      priorityForRole(left.role) - priorityForRole(right.role) ||
      left.id.localeCompare(right.id),
  );
  for (const binding of bindings) {
    if (
      binding.provider !== "google" ||
      binding.status !== "connected" ||
      binding.executionTarget !== "cloud_broker"
    ) {
      continue;
    }
    for (const product of binding.selectedProducts) {
      const normalizedProduct = product.trim().toLowerCase();
      const capability = GOOGLE_MCP_PRODUCT_CAPABILITIES[normalizedProduct];
      if (!capability || !binding.allowedCapabilities.includes(capability)) continue;
      const serverName = `google-${normalizedProduct}`;
      if (servers[serverName]) continue;
      servers[serverName] = {
        type: "streamable-http",
        url: `/api/v1/eliza/agents/${context.characterId}/connectors/${binding.id}/mcp/${normalizedProduct}`,
      };
    }
  }
  return servers;
}

function enabledServers(context: UserContext): Record<string, { url: string; type: string }> {
  const connected = getConnectedPlatforms(context);
  const legacy = Object.fromEntries(
    Object.entries(MCP_SERVER_CONFIGS).filter(([provider]) => connected.has(provider)),
  );
  return { ...legacy, ...googleBindingServers(context) };
}

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
  return Object.keys(enabledServers(context));
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
  const servers = enabledServers(context);

  if (Object.keys(servers).length === 0) return {};

  elizaLogger.debug(`[RuntimeFactory] MCP enabled: ${Object.keys(servers).join(", ")}`);

  return {
    mcp: transformMcpSettings({ servers }),
  };
}
