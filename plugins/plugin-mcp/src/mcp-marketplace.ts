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

interface McpRegistryListResponse {
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
}

export async function searchMcpMarketplace(
  query?: string,
  limit = 30
): Promise<{ results: McpMarketplaceSearchItem[] }> {
  const resp = await fetch(`${MCP_REGISTRY_BASE_URL}/v0/servers`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    throw new Error(`Registry API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as McpRegistryListResponse;
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

  return { results };
}

export async function getMcpServerDetails(name: string): Promise<McpRegistryServer | null> {
  const resp = await fetch(`${MCP_REGISTRY_BASE_URL}/v0/servers/${encodeURIComponent(name)}`, {
    headers: { Accept: "application/json" },
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      return null;
    }
    throw new Error(`Registry API error: ${resp.status}`);
  }

  const data = (await resp.json()) as { server: McpRegistryServer };
  return data.server;
}
