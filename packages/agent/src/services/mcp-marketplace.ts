/**
 * MCP Marketplace Service
 *
 * Fetches MCP servers from the official registry and manages local config.
 */

import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";

const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

export interface McpRegistryServer {
  name: string;
  title?: string;
  description: string;
  version: string;
  websiteUrl?: string;
  repository?: {
    url?: string;
    source?: string;
  };
  remotes?: Array<{
    type: "streamable-http" | "sse" | "http";
    url: string;
    headers?: Array<{
      name: string;
      description?: string;
      isRequired?: boolean;
      isSecret?: boolean;
    }>;
  }>;
  packages?: Array<{
    registryType: "npm" | "oci";
    identifier: string;
    version?: string;
    transport?: {
      type: "stdio";
    };
    environmentVariables?: Array<{
      name: string;
      description?: string;
      isSecret?: boolean;
      isRequired?: boolean;
      default?: string;
    }>;
    runtimeHint?: string;
    packageArguments?: Array<{
      name: string;
      description?: string;
      default?: string;
      isRequired?: boolean;
    }>;
  }>;
  icons?: Array<{
    src: string;
    mimeType?: string;
    sizes?: string[];
  }>;
}

export interface McpMarketplaceSearchItem {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  connectionType: "remote" | "stdio";
  connectionUrl?: string;
  npmPackage?: string;
  dockerImage?: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  iconUrl?: string;
  publishedAt?: string;
  isLatest: boolean;
}

export interface McpServerConfig {
  type: "stdio" | "http" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  timeoutInMillis?: number;
}

export interface McpConfiguredServers {
  servers: Record<string, McpServerConfig>;
}

export async function searchMcpMarketplace(
  query?: string,
  limit = 30,
): Promise<{ results: McpMarketplaceSearchItem[] }> {
  const url = `${MCP_REGISTRY_BASE_URL}/v0/servers`;
  const searchSpan = createIntegrationTelemetrySpan({
    boundary: "mcp",
    operation: "search_registry_servers",
  });

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });
  } catch (err) {
    searchSpan.failure({ error: err });
    throw err;
  }

  if (!resp.ok) {
    searchSpan.failure({ statusCode: resp.status, errorKind: "http_error" });
    throw new Error(`Registry API error: ${resp.status} ${resp.statusText}`);
  }

  let data: {
    servers: Array<{
      server: McpRegistryServer;
      _meta?: {
        "io.modelcontextprotocol.registry/official"?: {
          isLatest?: boolean;
          publishedAt?: string;
        };
      };
    }>;
    metadata?: { nextCursor?: string; count?: number };
  };
  try {
    data = (await resp.json()) as {
      servers: Array<{
        server: McpRegistryServer;
        _meta?: {
          "io.modelcontextprotocol.registry/official"?: {
            isLatest?: boolean;
            publishedAt?: string;
          };
        };
      }>;
      metadata?: { nextCursor?: string; count?: number };
    };
  } catch (err) {
    searchSpan.failure({ error: err, statusCode: resp.status });
    throw err;
  }

  const results: McpMarketplaceSearchItem[] = [];
  const seenNames = new Set<string>();

  for (const entry of data.servers) {
    const server = entry.server;
    const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];

    if (!meta?.isLatest) continue;
    if (seenNames.has(server.name)) continue;
    seenNames.add(server.name);

    if (query) {
      const q = query.toLowerCase();
      const matchName = server.name.toLowerCase().includes(q);
      const matchTitle = server.title?.toLowerCase().includes(q);
      const matchDesc = server.description?.toLowerCase().includes(q);
      if (!matchName && !matchTitle && !matchDesc) continue;
    }

    let connectionType: "remote" | "stdio" = "remote";
    let connectionUrl: string | undefined;
    let npmPackage: string | undefined;
    let dockerImage: string | undefined;

    if (server.remotes && server.remotes.length > 0) {
      connectionType = "remote";
      connectionUrl = server.remotes[0].url;
    } else if (server.packages && server.packages.length > 0) {
      const pkg = server.packages[0];
      connectionType = "stdio";
      if (pkg.registryType === "npm") {
        npmPackage = pkg.identifier;
      } else if (pkg.registryType === "oci") {
        dockerImage = pkg.identifier;
      }
    }

    results.push({
      id: `${server.name}@${server.version}`,
      name: server.name,
      title: server.title || server.name.split("/").pop() || server.name,
      description: server.description || "No description",
      version: server.version,
      connectionType,
      connectionUrl,
      npmPackage,
      dockerImage,
      repositoryUrl: server.repository?.url,
      websiteUrl: server.websiteUrl,
      iconUrl: server.icons?.[0]?.src,
      publishedAt: meta?.publishedAt,
      isLatest: true,
    });

    if (results.length >= limit) break;
  }

  searchSpan.success({ statusCode: resp.status });
  return { results };
}

export async function getMcpServerDetails(
  name: string,
): Promise<McpRegistryServer | null> {
  const url = `${MCP_REGISTRY_BASE_URL}/v0/servers/${encodeURIComponent(name)}`;
  const detailsSpan = createIntegrationTelemetrySpan({
    boundary: "mcp",
    operation: "get_registry_server_details",
  });
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    detailsSpan.failure({ error: err });
    throw err;
  }

  if (!resp.ok) {
    if (resp.status === 404) {
      detailsSpan.success({ statusCode: resp.status });
      return null;
    }
    detailsSpan.failure({ statusCode: resp.status, errorKind: "http_error" });
    throw new Error(`Registry API error: ${resp.status}`);
  }

  let data: { server: McpRegistryServer };
  try {
    data = (await resp.json()) as { server: McpRegistryServer };
  } catch (err) {
    detailsSpan.failure({ error: err, statusCode: resp.status });
    throw err;
  }
  detailsSpan.success({ statusCode: resp.status });
  return data.server;
}

export function generateMcpConfigFromRegistry(
  server: McpMarketplaceSearchItem,
): McpServerConfig | null {
  if (server.connectionType === "remote" && server.connectionUrl) {
    return {
      type: "streamable-http",
      url: server.connectionUrl,
    };
  } else if (server.connectionType === "stdio" && server.npmPackage) {
    return {
      type: "stdio",
      command: "npx",
      args: ["-y", server.npmPackage],
    };
  } else if (server.connectionType === "stdio" && server.dockerImage) {
    return {
      type: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", server.dockerImage],
    };
  }

  return null;
}

export function generateMcpConfigFromServerDetails(
  server: McpRegistryServer,
  envValues?: Record<string, string>,
  headerValues?: Record<string, string>,
): McpServerConfig | null {
  if (server.remotes && server.remotes.length > 0) {
    const remote = server.remotes[0];
    const config: McpServerConfig = {
      type: (remote.type as McpServerConfig["type"]) || "streamable-http",
      url: remote.url,
    };
    if (headerValues && Object.keys(headerValues).length > 0) {
      config.headers = { ...headerValues };
    }
    return config;
  }

  if (server.packages && server.packages.length > 0) {
    const pkg = server.packages[0];

    if (pkg.registryType === "npm") {
      const args = ["-y", pkg.identifier];
      if (pkg.packageArguments) {
        for (const arg of pkg.packageArguments) {
          if (arg.default) {
            args.push(arg.default);
          }
        }
      }
      const config: McpServerConfig = {
        type: "stdio",
        command: "npx",
        args,
      };
      if (envValues && Object.keys(envValues).length > 0) {
        config.env = { ...envValues };
      }
      return config;
    }

    if (pkg.registryType === "oci") {
      const config: McpServerConfig = {
        type: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", pkg.identifier],
      };
      if (envValues && Object.keys(envValues).length > 0) {
        config.env = { ...envValues };
      }
      return config;
    }
  }

  return null;
}
