/**
 * Stateless remote-resource execution for product-managed MCP connectors.
 * Attachments hold endpoint and authorization policy only; each discovery or
 * tool call opens an operation-local Streamable HTTP client and closes it
 * before returning, so connector lifetimes never depend on an MCP session ID.
 */

import { ElizaError, fetchWithSsrfGuard, logger } from "@elizaos/core";
import { validateMcpServerConfig } from "@elizaos/core/security/mcp-server-config";
import {
  type AuthProvider,
  type CallToolResult,
  Client,
  type Implementation,
  type Resource,
  type ResourceTemplateType,
  type ServerCapabilities,
  StreamableHTTPClientTransport,
  type Tool,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

const DEFAULT_RESOURCE_TIMEOUT_MS = 60_000;

export type McpAttachmentRef = Readonly<{
  key: string;
  generation: string;
}>;

export interface McpAccessTokenProvider {
  getAccessToken(context: {
    key: string;
    endpoint: URL;
    purpose: McpResourceOperationPurpose;
    signal?: AbortSignal;
  }): Promise<{ accessToken: string; expiresAt?: number }>;
  invalidateAccessToken?(context: {
    key: string;
    endpoint: URL;
    reason: "unauthorized" | "forbidden";
  }): Promise<void>;
}

export interface McpRemoteResource {
  key: string;
  endpoint: string | URL;
  auth?: McpAccessTokenProvider;
  requestTimeoutMs?: number;
}

export interface McpDiscovery {
  server: {
    info?: Implementation;
    capabilities: ServerCapabilities;
  };
  tools: readonly Tool[];
  resources: readonly Resource[];
  resourceTemplates: readonly ResourceTemplateType[];
}

export interface McpResourceEngine {
  attach(resource: McpRemoteResource): Promise<McpAttachmentRef>;
  detach(ref: McpAttachmentRef): Promise<boolean>;
  discover(ref: McpAttachmentRef, options?: { signal?: AbortSignal }): Promise<McpDiscovery>;
  callTool(
    ref: McpAttachmentRef,
    call: {
      name: string;
      arguments?: Readonly<Record<string, unknown>>;
    },
    options?: { signal?: AbortSignal }
  ): Promise<CallToolResult>;
}

export type McpResourceOperationPurpose = "discover" | "call-tool";

export interface McpResourceOperation {
  discover(): Promise<McpDiscovery>;
  callTool(call: {
    name: string;
    arguments?: Readonly<Record<string, unknown>>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpResourceOperationFactory = (request: {
  endpoint: URL;
  accessToken?: string;
  purpose: McpResourceOperationPurpose;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}) => Promise<McpResourceOperation>;

interface AttachedResource {
  readonly endpoint: URL;
  readonly generation: string;
  readonly auth?: McpAccessTokenProvider;
  readonly requestTimeoutMs: number;
  inFlight: number;
  drain?: { promise: Promise<void>; resolve: () => void };
}

export interface McpResourceEngineDependencies {
  openOperation?: McpResourceOperationFactory;
}

function detachedError(ref: McpAttachmentRef): ElizaError {
  return new ElizaError(`MCP resource "${ref.key}" is detached or stale`, {
    code: "MCP_RESOURCE_DETACHED",
    context: { key: ref.key },
  });
}

async function guardedResourceFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const guarded = await fetchWithSsrfGuard({
    url: input.toString(),
    ...(init ? { init } : {}),
  });
  await guarded.release();
  return guarded.response;
}

async function openDefaultOperation(request: {
  endpoint: URL;
  accessToken?: string;
  purpose: McpResourceOperationPurpose;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<McpResourceOperation> {
  const authProvider: AuthProvider | undefined = request.accessToken
    ? { token: async () => request.accessToken }
    : undefined;
  const client = new Client(
    { name: "elizaOS", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: "auto" },
    }
  );
  const transport = new StreamableHTTPClientTransport(request.endpoint, {
    authProvider,
    fetch: guardedResourceFetch,
    onInsufficientScope: "throw",
  });

  try {
    await client.connect(transport, {
      signal: request.signal,
      timeout: request.requestTimeoutMs,
    });
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    throw error;
  }

  return {
    discover: async () => {
      const capabilities = client.getServerCapabilities() ?? {};
      const tools: Tool[] = [];
      const resources: Resource[] = [];
      const resourceTemplates: ResourceTemplateType[] = [];
      const options = {
        signal: request.signal,
        timeout: request.requestTimeoutMs,
      };
      if (capabilities.tools) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, options);
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) {
            throw new ElizaError("MCP tools/list repeated a pagination cursor", {
              code: "MCP_RESOURCE_PAGINATION_LOOP",
            });
          }
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      if (capabilities.resources) {
        let resourceCursor: string | undefined;
        const seenResources = new Set<string>();
        do {
          const page = await client.listResources(
            resourceCursor ? { cursor: resourceCursor } : undefined,
            options
          );
          resources.push(...page.resources);
          resourceCursor = page.nextCursor;
          if (resourceCursor && seenResources.has(resourceCursor)) {
            throw new ElizaError("MCP resources/list repeated a pagination cursor", {
              code: "MCP_RESOURCE_PAGINATION_LOOP",
            });
          }
          if (resourceCursor) seenResources.add(resourceCursor);
        } while (resourceCursor);

        let templateCursor: string | undefined;
        const seenTemplates = new Set<string>();
        do {
          const page = await client.listResourceTemplates(
            templateCursor ? { cursor: templateCursor } : undefined,
            options
          );
          resourceTemplates.push(...page.resourceTemplates);
          templateCursor = page.nextCursor;
          if (templateCursor && seenTemplates.has(templateCursor)) {
            throw new ElizaError("MCP resources/templates/list repeated a pagination cursor", {
              code: "MCP_RESOURCE_PAGINATION_LOOP",
            });
          }
          if (templateCursor) seenTemplates.add(templateCursor);
        } while (templateCursor);
      }
      return {
        server: {
          info: client.getServerVersion(),
          capabilities,
        },
        tools,
        resources,
        resourceTemplates,
      };
    },
    callTool: async (call) =>
      client.callTool(
        {
          name: call.name,
          arguments: call.arguments ? { ...call.arguments } : undefined,
        },
        {
          signal: request.signal,
          timeout: request.requestTimeoutMs,
        }
      ),
    close: async () => client.close(),
  };
}

class DefaultMcpResourceEngine implements McpResourceEngine {
  private readonly attachments = new Map<string, AttachedResource>();
  private readonly openOperation: McpResourceOperationFactory;

  constructor(dependencies: McpResourceEngineDependencies) {
    this.openOperation = dependencies.openOperation ?? openDefaultOperation;
  }

  async attach(resource: McpRemoteResource): Promise<McpAttachmentRef> {
    const key = resource.key.trim();
    if (!key) {
      throw new ElizaError("MCP resource requires a non-empty key", {
        code: "MCP_RESOURCE_KEY_INVALID",
      });
    }
    if (this.attachments.has(key)) {
      throw new ElizaError(`MCP resource "${key}" is already attached`, {
        code: "MCP_RESOURCE_ALREADY_ATTACHED",
        context: { key },
      });
    }

    let endpoint: URL;
    try {
      endpoint = new URL(resource.endpoint);
    } catch (error) {
      throw new ElizaError(`MCP resource "${key}" has an invalid endpoint`, {
        code: "MCP_RESOURCE_ENDPOINT_INVALID",
        context: { key },
        cause: error,
      });
    }
    const rejection = await validateMcpServerConfig({
      type: "streamable-http",
      url: endpoint.toString(),
    });
    if (rejection) {
      throw new ElizaError(`MCP resource "${key}" has an unsafe endpoint`, {
        code: "MCP_RESOURCE_ENDPOINT_REJECTED",
        context: { key, rejection },
      });
    }
    const requestTimeoutMs = resource.requestTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new ElizaError(`MCP resource "${key}" has an invalid timeout`, {
        code: "MCP_RESOURCE_TIMEOUT_INVALID",
        context: { key, requestTimeoutMs },
      });
    }
    if (this.attachments.has(key)) {
      throw new ElizaError(`MCP resource "${key}" is already attached`, {
        code: "MCP_RESOURCE_ALREADY_ATTACHED",
        context: { key },
      });
    }

    const generation = crypto.randomUUID();
    this.attachments.set(key, {
      endpoint,
      generation,
      auth: resource.auth,
      requestTimeoutMs,
      inFlight: 0,
    });
    return { key, generation };
  }

  async detach(ref: McpAttachmentRef): Promise<boolean> {
    const attached = this.attachments.get(ref.key);
    if (!attached || attached.generation !== ref.generation) {
      return false;
    }
    this.attachments.delete(ref.key);
    if (attached.inFlight === 0) return true;
    attached.drain ??= (() => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    await attached.drain.promise;
    return true;
  }

  async discover(
    ref: McpAttachmentRef,
    options: { signal?: AbortSignal } = {}
  ): Promise<McpDiscovery> {
    return this.runOperation(ref, "discover", options.signal, (operation) => operation.discover());
  }

  async callTool(
    ref: McpAttachmentRef,
    call: {
      name: string;
      arguments?: Readonly<Record<string, unknown>>;
    },
    options: { signal?: AbortSignal } = {}
  ): Promise<CallToolResult> {
    return this.runOperation(ref, "call-tool", options.signal, (operation) =>
      operation.callTool({
        name: call.name,
        arguments: call.arguments ? { ...call.arguments } : undefined,
      })
    );
  }

  private async runOperation<T>(
    ref: McpAttachmentRef,
    purpose: McpResourceOperationPurpose,
    signal: AbortSignal | undefined,
    execute: (operation: McpResourceOperation) => Promise<T>
  ): Promise<T> {
    const attached = this.attachments.get(ref.key);
    if (!attached || attached.generation !== ref.generation) {
      throw detachedError(ref);
    }
    attached.inFlight += 1;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = attached.auth
          ? await attached.auth.getAccessToken({
              key: ref.key,
              endpoint: attached.endpoint,
              purpose,
              signal,
            })
          : undefined;
        if (attached.auth && !token?.accessToken.trim()) {
          throw new ElizaError(`MCP resource "${ref.key}" received an empty access token`, {
            code: "MCP_RESOURCE_ACCESS_TOKEN_INVALID",
            context: { key: ref.key, purpose },
          });
        }
        const current = this.attachments.get(ref.key);
        if (!current || current.generation !== ref.generation) {
          throw detachedError(ref);
        }

        const operation = await this.openOperation({
          endpoint: attached.endpoint,
          accessToken: token?.accessToken,
          purpose,
          requestTimeoutMs: attached.requestTimeoutMs,
          signal,
        });
        try {
          return await execute(operation);
        } catch (error) {
          if (
            attempt === 0 &&
            attached.auth?.invalidateAccessToken &&
            UnauthorizedError.isInstance(error)
          ) {
            await attached.auth.invalidateAccessToken({
              key: ref.key,
              endpoint: attached.endpoint,
              reason: "unauthorized",
            });
            continue;
          }
          throw error;
        } finally {
          try {
            await operation.close();
          } catch (error) {
            // error-policy:J6 operation-local teardown is best effort after the
            // observable discovery/tool result has already succeeded or failed.
            logger.warn(
              { error, key: ref.key, purpose },
              `[McpResourceEngine] Failed to close ${purpose} operation`
            );
          }
        }
      }
      throw new ElizaError(`MCP resource "${ref.key}" exhausted authorization retries`, {
        code: "MCP_RESOURCE_AUTH_RETRY_EXHAUSTED",
        context: { key: ref.key, purpose },
      });
    } finally {
      attached.inFlight -= 1;
      if (attached.inFlight === 0) attached.drain?.resolve();
    }
  }
}

export function createMcpResourceEngine(
  dependencies: McpResourceEngineDependencies = {}
): McpResourceEngine {
  return new DefaultMcpResourceEngine(dependencies);
}
