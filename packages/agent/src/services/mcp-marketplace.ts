/**
 * MCP Marketplace Service
 *
 * Fetches MCP servers from the official registry and manages local config.
 */

import { z } from "zod";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";

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

/** A stable, inspectable failure returned by the MCP registry client. */
export class McpMarketplaceError extends Error {
  constructor(
    message: string,
    public readonly code: McpMarketplaceErrorCode,
    options: ErrorOptions & { status?: number } = {},
  ) {
    super(message, options);
    this.name = "McpMarketplaceError";
    this.status = options.status;
  }

  public readonly status?: number;
}

export interface McpMarketplaceRequestOptions {
  /** Cancels the registry request when the caller no longer needs it. */
  signal?: AbortSignal;
  /** Request deadline in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum decoded response size in bytes. Defaults to 2 MiB. */
  maxResponseBytes?: number;
}

export interface McpRegistryInput {
  choices?: string[];
  default?: string;
  description?: string;
  format?: "string" | "number" | "boolean" | "filepath";
  isRequired?: boolean;
  isSecret?: boolean;
  placeholder?: string;
  value?: string;
  variables?: Record<string, unknown>;
}

export interface McpRegistryKeyValueInput extends McpRegistryInput {
  name: string;
}

export type McpRegistryArgument =
  | (McpRegistryInput & {
      type: "positional";
      valueHint?: string;
      isRepeated?: boolean;
    })
  | (McpRegistryInput & {
      type: "named";
      name: string;
      isRepeated?: boolean;
    });

export type McpRegistryLocalTransport =
  | { type: "stdio" }
  | {
      type: "streamable-http";
      url: string;
      headers?: McpRegistryKeyValueInput[];
    }
  | {
      type: "sse";
      url: string;
      headers?: McpRegistryKeyValueInput[];
    };

export type McpRegistryRemoteTransport =
  | {
      type: "streamable-http";
      url: string;
      headers?: McpRegistryKeyValueInput[];
    }
  | {
      type: "sse";
      url: string;
      headers?: McpRegistryKeyValueInput[];
    }
  | {
      /** Retained for compatibility with older registry payloads. */
      type: "http";
      url: string;
      headers?: McpRegistryKeyValueInput[];
    };

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
  remotes?: McpRegistryRemoteTransport[];
  packages?: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport?: McpRegistryLocalTransport;
    environmentVariables?: McpRegistryKeyValueInput[];
    runtimeHint?: string;
    runtimeArguments?: McpRegistryArgument[];
    packageArguments?: McpRegistryArgument[];
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

const optionalString = z.string().optional();
const registryInputSchema = z
  .object({
    choices: z.array(z.string()).optional(),
    default: optionalString,
    description: optionalString,
    format: z.enum(["string", "number", "boolean", "filepath"]).optional(),
    isSecret: z.boolean().optional(),
    isRequired: z.boolean().optional(),
    placeholder: optionalString,
    value: optionalString,
    variables: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const registryKeyValueInputSchema = registryInputSchema.extend({
  name: z.string(),
});

const registryPositionalArgumentSchema = registryInputSchema
  .extend({
    type: z.literal("positional"),
    valueHint: optionalString,
    isRepeated: z.boolean().optional(),
  })
  .refine(
    (argument) =>
      argument.valueHint !== undefined || argument.value !== undefined,
    "Positional arguments require valueHint or value",
  );

const registryNamedArgumentSchema = registryInputSchema.extend({
  type: z.literal("named"),
  name: z.string(),
  isRepeated: z.boolean().optional(),
});

const registryArgumentSchema = z.union([
  registryPositionalArgumentSchema,
  registryNamedArgumentSchema,
]);

const registryStdioTransportSchema = z
  .object({ type: z.literal("stdio") })
  .passthrough();
const registryStreamableHttpTransportSchema = z
  .object({
    type: z.literal("streamable-http"),
    url: z.string(),
    headers: z.array(registryKeyValueInputSchema).optional(),
  })
  .passthrough();
const registrySseTransportSchema = z
  .object({
    type: z.literal("sse"),
    url: z.string(),
    headers: z.array(registryKeyValueInputSchema).optional(),
  })
  .passthrough();
const registryLocalTransportSchema = z.union([
  registryStdioTransportSchema,
  registryStreamableHttpTransportSchema,
  registrySseTransportSchema,
]);
const registryRemoteTransportSchema = z.union([
  registryStreamableHttpTransportSchema,
  registrySseTransportSchema,
  z
    .object({
      /** Older registry payloads used `http` for streamable HTTP. */
      type: z.literal("http"),
      url: z.string(),
      headers: z.array(registryKeyValueInputSchema).optional(),
    })
    .passthrough(),
]);

const registryServerSchema = z
  .object({
    name: z.string().min(1),
    title: optionalString,
    description: z.string(),
    version: z.string().min(1),
    websiteUrl: optionalString,
    repository: z
      .object({
        url: optionalString,
        source: optionalString,
      })
      .passthrough()
      .optional(),
    remotes: z.array(registryRemoteTransportSchema).optional(),
    packages: z
      .array(
        z
          .object({
            registryType: z.string().min(1),
            identifier: z.string().min(1),
            version: optionalString,
            transport: registryLocalTransportSchema.optional(),
            environmentVariables: z
              .array(registryKeyValueInputSchema)
              .optional(),
            runtimeHint: optionalString,
            runtimeArguments: z.array(registryArgumentSchema).optional(),
            packageArguments: z.array(registryArgumentSchema).optional(),
          })
          .passthrough(),
      )
      .optional(),
    icons: z
      .array(
        z
          .object({
            src: z.string(),
            mimeType: optionalString,
            sizes: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const registryMetadataSchema = z
  .object({
    isLatest: z.boolean().optional(),
    publishedAt: optionalString,
  })
  .passthrough();

const registryEntrySchema = z
  .object({
    server: registryServerSchema,
    _meta: z
      .object({
        "io.modelcontextprotocol.registry/official":
          registryMetadataSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const registryListResponseSchema = z
  .object({
    servers: z.array(registryEntrySchema),
    metadata: z
      .object({
        nextCursor: optionalString,
        count: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const registryDetailsResponseSchema = z
  .object({ server: registryServerSchema })
  .passthrough();

interface ResolvedRequestOptions {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
  callerSignal?: AbortSignal;
  maxResponseBytes: number;
}

function resolveRequestOptions(
  options: McpMarketplaceRequestOptions,
): ResolvedRequestOptions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_MARKETPLACE_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MCP_MARKETPLACE_MAX_RESPONSE_BYTES;

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_MCP_MARKETPLACE_TIMEOUT_MS
  ) {
    throw new McpMarketplaceError(
      `MCP marketplace timeoutMs must be an integer from 1 to ${MAX_MCP_MARKETPLACE_TIMEOUT_MS}`,
      "invalid_options",
    );
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_MCP_MARKETPLACE_RESPONSE_BYTES
  ) {
    throw new McpMarketplaceError(
      `MCP marketplace maxResponseBytes must be an integer from 1 to ${MAX_MCP_MARKETPLACE_RESPONSE_BYTES}`,
      "invalid_options",
    );
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal,
    timeoutSignal,
    callerSignal: options.signal,
    maxResponseBytes,
  };
}

function classifyRequestError(
  error: unknown,
  options: ResolvedRequestOptions,
): McpMarketplaceError {
  if (error instanceof McpMarketplaceError) return error;
  if (options.callerSignal?.aborted) {
    return new McpMarketplaceError(
      "MCP marketplace request was aborted",
      "aborted",
      {
        cause: error,
      },
    );
  }
  if (options.timeoutSignal.aborted) {
    return new McpMarketplaceError(
      "MCP marketplace request timed out",
      "timeout",
      {
        cause: error,
      },
    );
  }
  return new McpMarketplaceError(
    "MCP marketplace request failed",
    "network_error",
    {
      cause: error,
    },
  );
}

async function cancelBodyQuietly(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Preserve the primary size-limit error if the transport rejects cancellation.
  }
}

async function readBoundedJson<T>(
  response: Response,
  maxResponseBytes: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      await cancelBodyQuietly(response.body);
      throw new McpMarketplaceError(
        `MCP registry response exceeded ${maxResponseBytes} bytes`,
        "response_too_large",
      );
    }
  }

  if (!response.body) {
    throw new McpMarketplaceError(
      "MCP registry returned an empty response",
      "invalid_response",
    );
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
        // Preserve the primary size-limit error if the transport rejects cancellation.
      }
      throw new McpMarketplaceError(
        `MCP registry response exceeded ${maxResponseBytes} bytes`,
        "response_too_large",
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

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new McpMarketplaceError(
      "MCP registry returned invalid JSON",
      "invalid_response",
      { cause: error },
    );
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new McpMarketplaceError(
      "MCP registry response did not match the expected schema",
      "invalid_response",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function fetchRegistryJson<T>(
  url: string,
  schema: z.ZodType<T>,
  options: McpMarketplaceRequestOptions,
): Promise<{ response: Response; data: T }> {
  const resolved = resolveRequestOptions(options);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: resolved.signal,
    });

    if (!response.ok) {
      throw new McpMarketplaceError(
        `MCP registry request failed with HTTP ${response.status}`,
        "http_error",
        { status: response.status },
      );
    }

    return {
      response,
      data: await readBoundedJson(response, resolved.maxResponseBytes, schema),
    };
  } catch (error) {
    throw classifyRequestError(error, resolved);
  }
}

export async function searchMcpMarketplace(
  query?: string,
  limit = 30,
  options: McpMarketplaceRequestOptions = {},
): Promise<{ results: McpMarketplaceSearchItem[] }> {
  const url = `${MCP_REGISTRY_BASE_URL}/v0/servers`;
  const searchSpan = createIntegrationTelemetrySpan({
    boundary: "mcp",
    operation: "search_registry_servers",
  });

  let response: Response;
  let data: z.infer<typeof registryListResponseSchema>;
  try {
    ({ response, data } = await fetchRegistryJson(
      url,
      registryListResponseSchema,
      options,
    ));
  } catch (error) {
    searchSpan.failure({
      error,
      statusCode:
        error instanceof McpMarketplaceError ? error.status : undefined,
      errorKind: error instanceof McpMarketplaceError ? error.code : undefined,
    });
    throw error;
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
      const matchDesc = server.description.toLowerCase().includes(q);
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
      if (pkg.transport && pkg.transport.type !== "stdio") {
        connectionType = "remote";
        connectionUrl = pkg.transport.url;
      } else {
        connectionType = "stdio";
        if (pkg.registryType === "npm") {
          npmPackage = pkg.identifier;
        } else if (pkg.registryType === "oci") {
          dockerImage = pkg.identifier;
        }
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

  searchSpan.success({ statusCode: response.status });
  return { results };
}

export async function getMcpServerDetails(
  name: string,
  options: McpMarketplaceRequestOptions = {},
): Promise<McpRegistryServer | null> {
  const url = `${MCP_REGISTRY_BASE_URL}/v0/servers/${encodeURIComponent(name)}/versions/latest`;
  const detailsSpan = createIntegrationTelemetrySpan({
    boundary: "mcp",
    operation: "get_registry_server_details",
  });

  try {
    const { response, data } = await fetchRegistryJson(
      url,
      registryDetailsResponseSchema,
      options,
    );
    detailsSpan.success({ statusCode: response.status });
    return data.server;
  } catch (error) {
    if (
      error instanceof McpMarketplaceError &&
      error.code === "http_error" &&
      error.status === 404
    ) {
      detailsSpan.success({ statusCode: 404 });
      return null;
    }
    detailsSpan.failure({
      error,
      statusCode:
        error instanceof McpMarketplaceError ? error.status : undefined,
      errorKind: error instanceof McpMarketplaceError ? error.code : undefined,
    });
    throw error;
  }
}
