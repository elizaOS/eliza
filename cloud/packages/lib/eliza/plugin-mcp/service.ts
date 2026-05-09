import { type Action, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { getRequestContext } from "@/lib/services/entity-settings/request-context";
import { createMcpToolActions, type McpToolAction } from "./actions/dynamic-tool-actions";
import { getSchemaCache, McpSchemaCache } from "./cache/schema-cache";
import { type Tier2ToolEntry, Tier2ToolIndex } from "./search/bm25-index";
import { createMcpToolCompatibilitySync, type McpToolCompatibility } from "./tool-compatibility";
import { getCrucialToolsForServer, isCrucialTool } from "./tool-visibility";
import {
  BACKOFF_MULTIPLIER,
  type ConnectionState,
  DEFAULT_MCP_TIMEOUT_MS,
  DEFAULT_PING_CONFIG,
  type HttpMcpServerConfig,
  INITIAL_RETRY_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  MCP_SERVICE_NAME,
  type McpConnection,
  type McpProvider,
  type McpServer,
  type McpServerConfig,
  type McpSettings,
  type PingConfig,
  type StdioMcpServerConfig,
} from "./types";
import { toActionName } from "./utils/action-naming";
import { buildMcpProviderData } from "./utils/mcp";

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class McpService extends Service {
  static serviceType = MCP_SERVICE_NAME;
  capabilityDescription = "Enables the agent to interact with MCP servers";

  private connections = new Map<string, McpConnection>();
  private connectionStates = new Map<string, ConnectionState>();
  /** Tracks the API key used when each connection was created, for staleness detection. */
  private connectionApiKeys = new Map<string, string>();
  private mcpProvider: McpProvider = {
    values: { mcp: {}, mcpText: "" },
    data: { mcp: {} },
    text: "",
  };
  private pingConfig: PingConfig = DEFAULT_PING_CONFIG;
  private toolCompatibility: McpToolCompatibility | null = null;
  private initPromise: Promise<void> | null = null;
  private registeredActions = new Map<string, McpToolAction>();
  private tier2Index = new Tier2ToolIndex();
  private tier2Tools: Tier2ToolEntry[] = [];
  private schemaCache = getSchemaCache();
  private lazyConnections = new Map<string, McpServerConfig>();
  /** Per-key mutex to prevent concurrent requests from creating duplicate connections */
  private connectionLocks = new Map<string, Promise<void>>();

  constructor(runtime?: IAgentRuntime) {
    if (!runtime) {
      throw new Error("McpService requires a runtime");
    }
    super(runtime);
    this.initPromise = this.init();
  }

  static async start(runtime: IAgentRuntime): Promise<McpService> {
    const svc = new McpService(runtime);
    await svc.initPromise;
    return svc;
  }

  async waitForInitialization(): Promise<void> {
    await this.initPromise;
  }

  async stop(): Promise<void> {
    for (const name of this.connections.keys()) {
      await this.disconnect(name);
    }
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    try {
      const settings = this.getSettings();
      if (!settings?.servers || Object.keys(settings.servers).length === 0) {
        this.mcpProvider = buildMcpProviderData([]);
        return;
      }

      const start = Date.now();
      const entries = Object.entries(settings.servers);
      const results = {
        cached: [] as string[],
        connected: [] as string[],
        failed: [] as string[],
      };

      await Promise.allSettled(
        entries.map(async ([name, config]) => {
          try {
            // In production, only streamable-http is supported on Workers.
            // stdio is only allowed in development/local environments.
            if (process.env.NODE_ENV === "production" && config.type !== "streamable-http") {
              logger.warn(
                `[MCP] Skipping server "${name}": transport "${config.type}" is not supported in production (only streamable-http is allowed)`,
              );
              results.failed.push(name);
              return;
            }

            const hash = this.schemaCache.hashConfig(config);

            // Try cache first
            if (this.schemaCache.isEnabled) {
              const cached = await this.schemaCache.getSchemas(this.runtime.agentId, name, hash);
              if (cached) {
                this.registerToolsAsActions(name, McpSchemaCache.toTools(cached));
                this.lazyConnections.set(name, config);
                results.cached.push(`${name}:${cached.tools.length}`);
                return;
              }
            }

            // For HTTP transports: connect temporarily to fetch schemas, then make lazy.
            // This ensures ensureConnected() creates per-entity connections on actual
            // tool use (with correct per-user API key from request context).
            const isHttpTransport = config.type && config.type !== "stdio";
            await this.connect(name, config);
            const server = this.connections.get(name)?.server;
            if (this.schemaCache.isEnabled && server?.tools?.length) {
              await this.schemaCache.setSchemas(this.runtime.agentId, name, hash, server.tools);
            }

            if (isHttpTransport) {
              // Disconnect and mark as lazy for per-entity reconnection
              const tools = server?.tools || [];
              await this.disconnect(name);
              this.lazyConnections.set(name, config);
              if (tools.length) this.registerToolsAsActions(name, tools);
              results.cached.push(`${name}:${tools.length}`);
            } else {
              // Stdio servers keep their persistent connection
              results.connected.push(`${name}:${server?.tools?.length || 0}`);
            }
          } catch (e) {
            logger.error({ error: err(e), server: name }, `[MCP] Failed: ${name}`);
            results.failed.push(name);
          }
        }),
      );

      const total = results.cached.length + results.connected.length;
      logger.info(
        `[MCP] Ready ${total}/${entries.length} in ${Date.now() - start}ms ` +
          `(${results.cached.length} cached, ${results.connected.length} connected, ${results.failed.length} failed)`,
      );

      this.mcpProvider = buildMcpProviderData(this.getServers());
    } catch (e) {
      logger.error({ error: err(e) }, "[MCP] Init failed");
      this.mcpProvider = buildMcpProviderData([]);
    }
  }

  private getSettings(): McpSettings | undefined {
    let s = this.runtime.getSetting("mcp") as McpSettings | string | boolean | number | null;
    if (!s || typeof s !== "object" || !("servers" in s)) {
      const rt = this.runtime as IAgentRuntime & {
        character?: { settings?: { mcp?: McpSettings } };
        settings?: { mcp?: McpSettings };
      };
      s = rt.character?.settings?.mcp ?? null;
      if (!s || typeof s !== "object" || !("servers" in s)) {
        s = rt.settings?.mcp ?? null;
      }
    }
    return s && typeof s === "object" && "servers" in s ? (s as McpSettings) : undefined;
  }

  // ─── Connection Management ─────────────────────────────────────────────────

  private async connect(
    name: string,
    config: McpServerConfig,
    options?: { skipActionRegistration?: boolean },
  ): Promise<void> {
    await this.disconnect(name);
    const state: ConnectionState = {
      status: "connecting",
      reconnectAttempts: 0,
      consecutivePingFailures: 0,
    };
    this.connectionStates.set(name, state);

    try {
      const client = new Client({ name: "ElizaOS", version: "1.0.0" }, { capabilities: {} });
      const transport =
        config.type === "stdio"
          ? this.createStdioTransport(name, config)
          : this.createHttpTransport(name, config);

      const conn: McpConnection = {
        server: { name, config: JSON.stringify(config), status: "connecting" },
        client,
        transport,
      };
      this.connections.set(name, conn);
      this.setupTransportHandlers(name, conn, state, config.type === "stdio");

      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Connection timeout")), 60000),
        ),
      ]);

      const caps = client.getServerCapabilities();
      const tools = await this.fetchTools(name);
      const resources = caps?.resources ? await this.fetchResources(name) : [];
      const resourceTemplates = caps?.resources ? await this.fetchResourceTemplates(name) : [];

      conn.server = {
        status: "connected",
        name,
        config: JSON.stringify(config),
        error: "",
        tools,
        resources,
        resourceTemplates,
      };
      state.status = "connected";
      state.lastConnected = new Date();
      state.reconnectAttempts = 0;
      state.consecutivePingFailures = 0;

      if (config.type === "stdio") this.startPingMonitor(name);
      if (!options?.skipActionRegistration) {
        this.registerToolsAsActions(name, tools);
      }

      logger.info(`[MCP] Connected: ${name} (${tools?.length || 0} tools)`);
    } catch (e) {
      state.status = "disconnected";
      state.lastError = e instanceof Error ? e : new Error(String(e));
      this.handleDisconnect(name, e);
      throw e;
    }
  }

  async disconnect(name: string): Promise<void> {
    this.unregisterToolsAsActions(name);
    const conn = this.connections.get(name);
    if (conn) {
      try {
        await conn.transport.close();
        await conn.client.close();
      } catch (e) {
        logger.debug(
          { error: err(e), server: name },
          "[MCP] Error during disconnect (expected during shutdown)",
        );
      }
      this.connections.delete(name);
    }
    this.connectionApiKeys.delete(name);
    const state = this.connectionStates.get(name);
    if (state) {
      if (state.pingInterval) clearInterval(state.pingInterval);
      if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
      this.connectionStates.delete(name);
    }
  }

  private createStdioTransport(name: string, config: StdioMcpServerConfig): StdioClientTransport {
    if (!config.command) throw new Error(`Missing command for stdio server ${name}`);
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...config.env,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
      stderr: "pipe",
      cwd: config.cwd,
    });
  }

  private createHttpTransport(
    name: string,
    config: HttpMcpServerConfig,
  ): StreamableHTTPClientTransport {
    if (!config.url) throw new Error(`Missing URL for server ${name}`);
    const url = new URL(config.url);
    const headers: Record<string, string> = { ...config.headers };

    // Dynamic API key injection for per-user multi-tenant support
    // getSetting() checks request context first, then falls back to agent.settings
    const apiKey = this.runtime.getSetting("ELIZAOS_API_KEY");
    if (apiKey && typeof apiKey === "string" && !headers["X-API-Key"]) {
      // Only inject for same-origin to prevent leaking to external domains
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3000";
      try {
        if (url.origin === new URL(baseUrl).origin) {
          headers["X-API-Key"] = apiKey;
        }
      } catch {
        /* ignore invalid URLs */
      }
    }

    // Track API key used for this connection so we can detect rotation later
    if (apiKey && typeof apiKey === "string") {
      this.connectionApiKeys.set(name, apiKey);
    }

    const opts = Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined;
    return new StreamableHTTPClientTransport(url, opts);
  }

  private setupTransportHandlers(
    name: string,
    conn: McpConnection,
    _state: ConnectionState,
    isStdio: boolean,
  ): void {
    conn.transport.onerror = async (e) => {
      const isAbortError = e?.name === "AbortError";
      if (!isStdio && isAbortError) {
        logger.debug({ error: e, server: name }, `[MCP] Suppressed transport AbortError: ${name}`);
        return;
      }

      const msg = e?.message || "";
      if (isStdio || (!msg.includes("SSE") && !msg.includes("timeout") && msg !== "undefined")) {
        logger.error({ error: e, server: name }, `[MCP] Transport error: ${name}`);
        conn.server.status = "disconnected";
        conn.server.error = `${conn.server.error || ""}\n${msg}`;
      }
      if (isStdio) this.handleDisconnect(name, e);
    };

    conn.transport.onclose = async () => {
      if (isStdio) {
        conn.server.status = "disconnected";
        this.handleDisconnect(name, new Error("Transport closed"));
      }
    };
  }

  // ─── Ping & Reconnect ──────────────────────────────────────────────────────

  private startPingMonitor(name: string): void {
    const state = this.connectionStates.get(name);
    if (!state || !this.pingConfig.enabled) return;
    if (state.pingInterval) clearInterval(state.pingInterval);

    state.pingInterval = setInterval(async () => {
      const conn = this.connections.get(name);
      if (!conn) return;
      try {
        await Promise.race([
          conn.client.listTools(),
          new Promise((_, r) =>
            setTimeout(() => r(new Error("Ping timeout")), this.pingConfig.timeoutMs),
          ),
        ]);
        state.consecutivePingFailures = 0;
      } catch (e) {
        state.consecutivePingFailures++;
        if (state.consecutivePingFailures >= this.pingConfig.failuresBeforeDisconnect) {
          this.handleDisconnect(name, e);
        }
      }
    }, this.pingConfig.intervalMs);
  }

  private handleDisconnect(name: string, error: unknown): void {
    const state = this.connectionStates.get(name);
    if (!state) return;
    state.status = "disconnected";
    state.lastError = error instanceof Error ? error : new Error(String(error));
    if (state.pingInterval) clearInterval(state.pingInterval);
    if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);

    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error(`[MCP] Max reconnect attempts for ${name}`);
      return;
    }

    const delay = INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** state.reconnectAttempts;
    state.reconnectTimeout = setTimeout(async () => {
      state.reconnectAttempts++;
      const config = this.connections.get(name)?.server.config;
      if (config) {
        try {
          await this.connect(name, JSON.parse(config));
        } catch (e) {
          this.handleDisconnect(name, e);
        }
      }
    }, delay);
  }

  // ─── Data Fetching ─────────────────────────────────────────────────────────

  private async fetchTools(name: string): Promise<Tool[]> {
    const conn = this.connections.get(name);
    if (!conn) return [];
    try {
      const res = await conn.client.listTools();
      return (res?.tools || []).map((t) => {
        if (!t.inputSchema) return t;
        const toolCompatibility =
          this.toolCompatibility ?? createMcpToolCompatibilitySync(this.runtime);
        this.toolCompatibility = toolCompatibility;
        if (!toolCompatibility) return t;
        try {
          const inputSchema = toolCompatibility.transformToolSchema(
            t.inputSchema,
          ) as Tool["inputSchema"];
          return { ...t, inputSchema };
        } catch (e) {
          logger.debug(
            { error: err(e), tool: t.name },
            "[MCP] Schema transform failed, using original",
          );
          return t;
        }
      });
    } catch (e) {
      logger.warn({ error: err(e), server: name }, "[MCP] Failed to fetch tools");
      return [];
    }
  }

  private async fetchResources(name: string): Promise<Resource[]> {
    try {
      return (await this.connections.get(name)?.client.listResources())?.resources || [];
    } catch (e) {
      logger.debug({ error: err(e), server: name }, "[MCP] Failed to fetch resources");
      return [];
    }
  }

  private async fetchResourceTemplates(name: string): Promise<ResourceTemplate[]> {
    try {
      return (
        (await this.connections.get(name)?.client.listResourceTemplates())?.resourceTemplates || []
      );
    } catch (e) {
      logger.debug({ error: err(e), server: name }, "[MCP] Failed to fetch resource templates");
      return [];
    }
  }

  // ─── Action Registration ───────────────────────────────────────────────────

  private registerToolsAsActions(serverName: string, tools: Tool[]): void {
    if (!tools?.length) return;

    // Split tools into Tier-1 (crucial, always visible) and Tier-2 (discoverable via SEARCH_ACTIONS).
    // Servers without a curated crucial-tools list register ALL tools as Tier-1 (old behavior).
    const hasCuratedList = getCrucialToolsForServer(serverName).length > 0;
    const crucialTools: Tool[] = [];
    const tier2Entries: Tier2ToolEntry[] = [];

    for (const tool of tools) {
      if (!hasCuratedList || isCrucialTool(serverName, tool.name)) {
        crucialTools.push(tool);
      } else {
        tier2Entries.push({
          serverName,
          toolName: tool.name,
          actionName: toActionName(serverName, tool.name),
          platform: serverName.toLowerCase(),
          tool,
        });
      }
    }

    // Register Tier-1 crucial tools as runtime actions
    if (crucialTools.length > 0) {
      const existing = new Set([
        ...this.runtime.actions.map((a) => a.name),
        ...this.registeredActions.keys(),
      ]);
      const actions = createMcpToolActions(serverName, crucialTools, existing);

      for (const action of actions) {
        if (!this.registeredActions.has(String(action.name))) {
          this.runtime.registerAction(action as Action);
          this.registeredActions.set(String(action.name), action);
        }
      }
    }

    // Add Tier-2 tools to the discoverable index
    if (tier2Entries.length > 0) {
      this.tier2Tools = [
        ...this.tier2Tools.filter((t) => t.serverName !== serverName),
        ...tier2Entries,
      ];
      this.tier2Index.build(this.tier2Tools);
    }

    logger.info(
      `[MCP] ${serverName}: ${crucialTools.length} crucial (registered), ${tier2Entries.length} tier-2 (indexed)`,
    );
  }

  private unregisterToolsAsActions(serverName: string): void {
    // Remove Tier-1 actions
    const toRemove: string[] = [];
    for (const [name, action] of this.registeredActions) {
      if (action._mcpMeta.serverName === serverName) toRemove.push(name);
    }

    for (const name of toRemove) {
      const idx = this.runtime.actions.findIndex((a) => a.name === name);
      if (idx !== -1) this.runtime.actions.splice(idx, 1);
      this.registeredActions.delete(name);
    }

    // Remove Tier-2 entries and rebuild index
    const hadTier2 = this.tier2Tools.some((t) => t.serverName === serverName);
    if (hadTier2) {
      this.tier2Tools = this.tier2Tools.filter((t) => t.serverName !== serverName);
      this.tier2Index.build(this.tier2Tools);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getServers(): McpServer[] {
    return Array.from(this.connections.values())
      .filter((c) => !c.server.disabled)
      .map((c) => c.server);
  }

  getProviderData(): McpProvider {
    return this.mcpProvider;
  }

  getRegisteredActions(): McpToolAction[] {
    return Array.from(this.registeredActions.values());
  }

  getTier2Index(): Tier2ToolIndex {
    return this.tier2Index;
  }

  /** Remove promoted actions from both the source array and BM25 index. */
  removeFromTier2(actionNames: string[]): void {
    if (actionNames.length === 0) return;
    const nameSet = new Set(actionNames);
    this.tier2Tools = this.tier2Tools.filter((t) => !nameSet.has(t.actionName));
    this.tier2Index.build(this.tier2Tools);
  }

  isLazyConnection(serverName: string): boolean {
    return this.lazyConnections.has(serverName);
  }

  /**
   * Get connection key for a server. Returns user-specific key for HTTP transports
   * (per-user isolation), or base serverName for stdio (shared connection).
   */
  private getConnectionKey(serverName: string): string {
    const config = this.lazyConnections.get(serverName);
    if (config && config.type !== "stdio") {
      const ctx = getRequestContext();
      if (ctx?.entityId) return `${serverName}:${ctx.entityId}`;
    }
    return serverName;
  }

  /**
   * Get connection for a server, checking user-specific first then shared.
   */
  private getConnection(serverName: string): McpConnection | undefined {
    const key = this.getConnectionKey(serverName);
    return this.connections.get(key) || this.connections.get(serverName);
  }

  async ensureConnected(serverName: string): Promise<void> {
    const connectionKey = this.getConnectionKey(serverName);

    // API key freshness guard: if the key rotated since connection creation, disconnect stale connection
    const matchedKey = this.connections.has(connectionKey)
      ? connectionKey
      : this.connections.has(serverName)
        ? serverName
        : null;
    if (matchedKey) {
      const currentKey = this.runtime.getSetting("ELIZAOS_API_KEY") ?? "";
      const storedKey = this.connectionApiKeys.get(matchedKey) ?? "";
      if (currentKey !== storedKey) {
        logger.info(`[MCP] API key changed for ${matchedKey}, reconnecting`);
        await this.disconnect(matchedKey);
      } else {
        return;
      }
    }

    // Serialize per-key to prevent concurrent requests from creating duplicate connections
    const inflight = this.connectionLocks.get(connectionKey);
    if (inflight) {
      await inflight;
      return;
    }

    const promise = this.doConnect(connectionKey, serverName);
    this.connectionLocks.set(connectionKey, promise);
    try {
      await promise;
    } finally {
      this.connectionLocks.delete(connectionKey);
    }
  }

  private async doConnect(connectionKey: string, serverName: string): Promise<void> {
    // Re-check after acquiring the "lock"
    if (this.connections.has(connectionKey) || this.connections.has(serverName)) return;

    const config = this.lazyConnections.get(serverName);
    if (!config) throw new Error(`Unknown server: ${serverName}`);

    const start = Date.now();
    // Skip action registration for per-entity connections — actions are already
    // registered under the base serverName during init().
    const isPerEntity = connectionKey !== serverName;
    await this.connect(connectionKey, config, {
      skipActionRegistration: isPerEntity,
    });

    const server = this.connections.get(connectionKey)?.server;
    if (this.schemaCache.isEnabled && server?.tools?.length) {
      await this.schemaCache.setSchemas(
        this.runtime.agentId,
        serverName,
        this.schemaCache.hashConfig(config),
        server.tools,
      );
    }

    logger.info(`[MCP] Connected: ${connectionKey} in ${Date.now() - start}ms`);
    this.mcpProvider = buildMcpProviderData(this.getServers());
  }

  async callTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<CallToolResult> {
    await this.ensureConnected(serverName);
    const conn = this.getConnection(serverName);
    if (!conn) throw new Error(`No connection: ${serverName}`);
    if (conn.server.disabled) throw new Error(`Server disabled: ${serverName}`);

    const config = JSON.parse(conn.server.config);
    const timeout = config.timeoutInMillis || DEFAULT_MCP_TIMEOUT_MS;
    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout,
    });
    if (!result.content) throw new Error("Invalid tool result");
    return result as CallToolResult;
  }

  async readResource(serverName: string, uri: string): Promise<unknown> {
    await this.ensureConnected(serverName);
    const conn = this.getConnection(serverName);
    if (!conn) throw new Error(`No connection: ${serverName}`);
    if (conn.server.disabled) throw new Error(`Server disabled: ${serverName}`);
    return conn.client.readResource({ uri });
  }

  async restartConnection(serverName: string): Promise<void> {
    const connectionKey = this.getConnectionKey(serverName);
    const conn = this.getConnection(serverName);
    if (!conn) throw new Error(`No connection: ${serverName}`);
    const config = JSON.parse(conn.server.config);
    await this.disconnect(connectionKey);
    const isPerEntity = connectionKey !== serverName;
    await this.connect(connectionKey, config, {
      skipActionRegistration: isPerEntity,
    });
  }
}
