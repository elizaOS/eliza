/**
 * Read-only, bounded client for the public MCP Registry. This is the single
 * marketplace client used by the plugin's live HTTP routes and public API.
 */
const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

export const DEFAULT_MCP_MARKETPLACE_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_MARKETPLACE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MCP_MARKETPLACE_TIMEOUT_MS = 2 * 60_000;
const MAX_MCP_MARKETPLACE_RESPONSE_BYTES = 8 * 1024 * 1024;

export type McpMarketplaceErrorCode =
  | "aborted"
  | "http_error"
  | "invalid_options"
  | "invalid_response"
  | "network_error"
  | "response_too_large"
  | "timeout";

export class McpMarketplaceError extends Error {
  public readonly status?: number;

  constructor(
    message: string,
    public readonly code: McpMarketplaceErrorCode,
    options: ErrorOptions & { status?: number } = {}
  ) {
    super(message, options);
    this.name = "McpMarketplaceError";
    this.status = options.status;
  }
}

export interface McpMarketplaceRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface McpRegistryRemote extends Record<string, unknown> {
  type?: string;
  url: string;
}

export interface McpRegistryPackageTransport extends Record<string, unknown> {
  type: string;
  url?: string;
}

export interface McpRegistryPackage extends Record<string, unknown> {
  registryType: string;
  identifier: string;
  version?: string;
  transport?: McpRegistryPackageTransport;
}

export interface McpRegistryServer extends Record<string, unknown> {
  name: string;
  title?: string;
  description: string;
  version: string;
  websiteUrl?: string;
  repository?: Record<string, unknown> & { url?: string };
  remotes?: McpRegistryRemote[];
  packages?: McpRegistryPackage[];
  icons?: Array<Record<string, unknown> & { src: string }>;
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

interface McpRegistryOfficialMetadata extends Record<string, unknown> {
  isLatest?: boolean;
  publishedAt?: string;
}

interface McpRegistryEntry {
  server: McpRegistryServer;
  official?: McpRegistryOfficialMetadata;
}

interface ResolvedRequestOptions {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
  callerSignal?: AbortSignal;
  maxResponseBytes: number;
}

function invalidResponse(message: string, cause?: unknown): never {
  throw new McpMarketplaceError(message, "invalid_response", { cause });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse(`MCP registry ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    invalidResponse(`MCP registry ${label} must be an array`);
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: { allowEmpty?: boolean } = {}
): string {
  const value = record[key];
  if (typeof value !== "string" || (!options.allowEmpty && !value)) {
    invalidResponse(
      `MCP registry ${label}.${key} must be ${options.allowEmpty ? "a string" : "a non-empty string"}`
    );
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    invalidResponse(`MCP registry ${label}.${key} must be a string`);
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    invalidResponse(`MCP registry ${label}.${key} must be a boolean`);
  }
  return value;
}

function parseRemote(value: unknown, label: string): McpRegistryRemote {
  const source = requireRecord(value, label);
  return {
    ...source,
    type: optionalString(source, "type", label),
    url: requireString(source, "url", label),
  };
}

function parsePackageTransport(value: unknown, label: string): McpRegistryPackageTransport {
  const source = requireRecord(value, label);
  const type = requireString(source, "type", label);
  const url = optionalString(source, "url", label);
  if (type !== "stdio" && !url) {
    invalidResponse(`MCP registry ${label}.url is required for ${type}`);
  }
  return { ...source, type, url };
}

function parsePackage(value: unknown, label: string): McpRegistryPackage {
  const source = requireRecord(value, label);
  const transport =
    source.transport === undefined
      ? undefined
      : parsePackageTransport(source.transport, `${label}.transport`);
  return {
    ...source,
    registryType: requireString(source, "registryType", label),
    identifier: requireString(source, "identifier", label),
    version: optionalString(source, "version", label),
    transport,
  };
}

function parseServer(value: unknown, label: string): McpRegistryServer {
  const source = requireRecord(value, label);
  const repository =
    source.repository === undefined
      ? undefined
      : requireRecord(source.repository, `${label}.repository`);
  const remotes =
    source.remotes === undefined
      ? undefined
      : requireArray(source.remotes, `${label}.remotes`).map((entry, index) =>
          parseRemote(entry, `${label}.remotes[${index}]`)
        );
  const packages =
    source.packages === undefined
      ? undefined
      : requireArray(source.packages, `${label}.packages`).map((entry, index) =>
          parsePackage(entry, `${label}.packages[${index}]`)
        );
  const icons =
    source.icons === undefined
      ? undefined
      : requireArray(source.icons, `${label}.icons`).map((entry, index) => {
          const icon = requireRecord(entry, `${label}.icons[${index}]`);
          return {
            ...icon,
            src: requireString(icon, "src", `${label}.icons[${index}]`),
          };
        });

  return {
    ...source,
    name: requireString(source, "name", label),
    title: optionalString(source, "title", label),
    description: requireString(source, "description", label, {
      allowEmpty: true,
    }),
    version: requireString(source, "version", label),
    websiteUrl: optionalString(source, "websiteUrl", label),
    repository: repository
      ? {
          ...repository,
          url: optionalString(repository, "url", `${label}.repository`),
        }
      : undefined,
    remotes,
    packages,
    icons,
  };
}

function parseOfficialMetadata(value: unknown, label: string): McpRegistryOfficialMetadata {
  const source = requireRecord(value, label);
  return {
    ...source,
    isLatest: optionalBoolean(source, "isLatest", label),
    publishedAt: optionalString(source, "publishedAt", label),
  };
}

function parseListResponse(value: unknown): McpRegistryEntry[] {
  const root = requireRecord(value, "response");
  return requireArray(root.servers, "response.servers").map((entry, index) => {
    const source = requireRecord(entry, `response.servers[${index}]`);
    const metadata =
      source._meta === undefined
        ? undefined
        : requireRecord(source._meta, `response.servers[${index}]._meta`);
    const officialValue = metadata?.["io.modelcontextprotocol.registry/official"];
    return {
      server: parseServer(source.server, `response.servers[${index}].server`),
      official:
        officialValue === undefined
          ? undefined
          : parseOfficialMetadata(
              officialValue,
              `response.servers[${index}]._meta.io.modelcontextprotocol.registry/official`
            ),
    };
  });
}

function parseDetailsResponse(value: unknown): McpRegistryServer {
  const root = requireRecord(value, "response");
  return parseServer(root.server, "response.server");
}

function resolveRequestOptions(options: McpMarketplaceRequestOptions): ResolvedRequestOptions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_MARKETPLACE_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MCP_MARKETPLACE_MAX_RESPONSE_BYTES;

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_MCP_MARKETPLACE_TIMEOUT_MS
  ) {
    throw new McpMarketplaceError(
      `MCP marketplace timeoutMs must be an integer from 1 to ${MAX_MCP_MARKETPLACE_TIMEOUT_MS}`,
      "invalid_options"
    );
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_MCP_MARKETPLACE_RESPONSE_BYTES
  ) {
    throw new McpMarketplaceError(
      `MCP marketplace maxResponseBytes must be an integer from 1 to ${MAX_MCP_MARKETPLACE_RESPONSE_BYTES}`,
      "invalid_options"
    );
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
    timeoutSignal,
    callerSignal: options.signal,
    maxResponseBytes,
  };
}

function classifyRequestError(
  error: unknown,
  options: ResolvedRequestOptions
): McpMarketplaceError {
  if (error instanceof McpMarketplaceError) return error;
  if (options.callerSignal?.aborted) {
    return new McpMarketplaceError("MCP marketplace request was aborted", "aborted", {
      cause: error,
    });
  }
  if (options.timeoutSignal.aborted) {
    return new McpMarketplaceError("MCP marketplace request timed out", "timeout", {
      cause: error,
    });
  }
  return new McpMarketplaceError("MCP marketplace request failed", "network_error", {
    cause: error,
  });
}

async function cancelBodyQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Preserve the primary boundary error when transport cancellation fails.
  }
}

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
    await cancelBodyQuietly(response.body);
    throw new McpMarketplaceError(
      `MCP registry response exceeded ${maxResponseBytes} bytes`,
      "response_too_large"
    );
  }
  if (!response.body) {
    invalidResponse("MCP registry returned an empty response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the size error when stream cancellation fails.
      }
      throw new McpMarketplaceError(
        `MCP registry response exceeded ${maxResponseBytes} bytes`,
        "response_too_large"
      );
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    invalidResponse("MCP registry returned invalid JSON", error);
  }
}

async function fetchRegistryJson<T>(
  url: string,
  parse: (value: unknown) => T,
  options: McpMarketplaceRequestOptions
): Promise<T> {
  const resolved = resolveRequestOptions(options);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: resolved.signal,
    });
    if (!response.ok) {
      await cancelBodyQuietly(response.body);
      throw new McpMarketplaceError(
        `MCP registry request failed with HTTP ${response.status}`,
        "http_error",
        { status: response.status }
      );
    }
    return parse(await readBoundedJson(response, resolved.maxResponseBytes));
  } catch (error) {
    throw classifyRequestError(error, resolved);
  }
}

export async function searchMcpMarketplace(
  query?: string,
  limit = 30,
  options: McpMarketplaceRequestOptions = {}
): Promise<{ results: McpMarketplaceSearchItem[] }> {
  const entries = await fetchRegistryJson(
    `${MCP_REGISTRY_BASE_URL}/v0/servers`,
    parseListResponse,
    options
  );
  const results: McpMarketplaceSearchItem[] = [];
  const seenNames = new Set<string>();
  const normalizedQuery = query?.toLowerCase();

  for (const { server, official } of entries) {
    if (!official?.isLatest || seenNames.has(server.name)) continue;
    seenNames.add(server.name);
    if (
      normalizedQuery &&
      !server.name.toLowerCase().includes(normalizedQuery) &&
      !server.title?.toLowerCase().includes(normalizedQuery) &&
      !server.description.toLowerCase().includes(normalizedQuery)
    ) {
      continue;
    }

    const remote = server.remotes?.[0];
    const pkg = server.packages?.[0];
    const packageRemote =
      pkg?.transport && pkg.transport.type !== "stdio" ? pkg.transport.url : undefined;
    const connectionType = remote || packageRemote ? "remote" : "stdio";

    results.push({
      id: `${server.name}@${server.version}`,
      name: server.name,
      title: server.title || server.name.split("/").pop() || server.name,
      description: server.description || "No description",
      version: server.version,
      connectionType,
      connectionUrl: remote?.url ?? packageRemote,
      npmPackage:
        connectionType === "stdio" && pkg?.registryType === "npm" ? pkg.identifier : undefined,
      dockerImage:
        connectionType === "stdio" && pkg?.registryType === "oci" ? pkg.identifier : undefined,
      repositoryUrl: server.repository?.url,
      websiteUrl: server.websiteUrl,
      iconUrl: server.icons?.[0]?.src,
      publishedAt: official.publishedAt,
      isLatest: true,
    });
    if (results.length >= limit) break;
  }

  return { results };
}

export async function getMcpServerDetails(
  name: string,
  options: McpMarketplaceRequestOptions = {}
): Promise<McpRegistryServer | null> {
  try {
    return await fetchRegistryJson(
      `${MCP_REGISTRY_BASE_URL}/v0/servers/${encodeURIComponent(name)}/versions/latest`,
      parseDetailsResponse,
      options
    );
  } catch (error) {
    if (
      error instanceof McpMarketplaceError &&
      error.code === "http_error" &&
      error.status === 404
    ) {
      return null;
    }
    throw error;
  }
}
