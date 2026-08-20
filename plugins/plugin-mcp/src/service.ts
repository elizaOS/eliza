/**
 * McpService — owns the lifecycle of every MCP server connection: validates each
 * config through the core security boundary, builds the stdio or HTTP-SSE transport,
 * connects the SDK client, and discovers its tools, resources, and resource
 * templates.
 *
 * Servers come from `settings.mcp.servers` and from `MCP_SERVER_<NAME>_URL`
 * environment variables (env wins on a name collision). Env declaration keeps a
 * credential-bearing URL out of character settings, so it never persists into
 * the character file or the agent database.
 *
 * Stdio connections are health-checked with a periodic ping and reconnected with
 * exponential backoff; HTTP/SSE connections rely on transport error/close events
 * instead. Exposes callTool / readResource / getServers / getProviderData /
 * restartConnection to the action and route layers. Tool input schemas are
 * rewritten per model provider via the tool-compatibility layer.
 */
import { ElizaError, fetchWithSsrfGuard, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { validateMcpServerConfig } from "@elizaos/core/security/mcp-server-config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONSchema7 } from "json-schema";
import {
  createMcpToolCompatibilitySync as createMcpToolCompatibility,
  type McpToolCompatibility,
} from "./tool-compatibility";
import {
  BACKOFF_MULTIPLIER,
  type ConnectionState,
  DEFAULT_MCP_TIMEOUT_SECONDS,
  DEFAULT_PING_CONFIG,
  type HttpMcpServerConfig,
  INITIAL_RETRY_DELAY,
  isMcpSettings,
  MAX_RECONNECT_ATTEMPTS,
  MCP_SERVICE_NAME,
  type McpConnection,
  type McpProvider,
  type McpResourceResponse,
  type McpServer,
  type McpServerConfig,
  type McpSettings,
  type PingConfig,
  type StdioMcpServerConfig,
} from "./types";
import { buildMcpProviderData } from "./utils/mcp";

/** Route every MCP HTTP request through core's DNS-pinned SSRF transport. */
export async function guardedMcpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const guarded = await fetchWithSsrfGuard({
    url: input.toString(),
    ...(init ? { init } : {}),
  });
  await guarded.release();
  return guarded.response;
}

export class McpService extends Service {
  static serviceType: string = MCP_SERVICE_NAME;
  capabilityDescription = "Enables the agent to interact with MCP (Model Context Protocol) servers";

  private connections: Map<string, McpConnection> = new Map();
  private connectionStates: Map<string, ConnectionState> = new Map();
  private mcpProvider: McpProvider = {
    values: { mcp: {}, mcpText: "" },
    data: { mcp: {} },
    text: "",
  };
  private pingConfig: PingConfig = DEFAULT_PING_CONFIG;
  private toolCompatibility: McpToolCompatibility | null = null;
  private compatibilityInitialized = false;

  private initializationPromise: Promise<void> | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.initializationPromise = this.initializeMcpServers();
    }
  }

  static async start(runtime: IAgentRuntime): Promise<McpService> {
    const service = new McpService(runtime);
    if (service.initializationPromise) {
      await service.initializationPromise;
    }
    return service;
  }

  async waitForInitialization(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  async stop(): Promise<void> {
    for (const [name] of this.connections) {
      await this.deleteConnection(name);
    }
    this.connections.clear();
    for (const state of this.connectionStates.values()) {
      if (state.pingInterval) clearInterval(state.pingInterval);
      if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
    }
    this.connectionStates.clear();
  }

  private async initializeMcpServers(): Promise<void> {
    const mcpSettings = this.getMcpSettings();

    if (!mcpSettings?.servers || Object.keys(mcpSettings.servers).length === 0) {
      this.mcpProvider = buildMcpProviderData([]);
      return;
    }

    await this.updateServerConnections(mcpSettings.servers);
    const servers = this.getServers();
    this.mcpProvider = buildMcpProviderData(servers);
  }

  private getMcpSettings(): McpSettings | undefined {
    const configured = this.getConfiguredMcpSettings();
    const envServers = this.readEnvMcpServers();
    if (Object.keys(envServers).length === 0) {
      return configured;
    }
    return {
      ...(configured ?? {}),
      servers: { ...(configured?.servers ?? {}), ...envServers },
    };
  }

  private getConfiguredMcpSettings(): McpSettings | undefined {
    const rawSettings = this.runtime.getSetting("mcp");
    if (rawSettings !== undefined && rawSettings !== null) {
      if (!isMcpSettings(rawSettings)) {
        throw new ElizaError("MCP settings are malformed", {
          code: "MCP_SETTINGS_INVALID",
          severity: "fatal",
        });
      }
      return rawSettings;
    }

    const characterSettings = this.runtime.character.settings;
    if (characterSettings && typeof characterSettings === "object" && "mcp" in characterSettings) {
      const characterMcpSettings = characterSettings.mcp;
      if (!isMcpSettings(characterMcpSettings)) {
        throw new ElizaError("Character MCP settings are malformed", {
          code: "MCP_SETTINGS_INVALID",
          severity: "fatal",
        });
      }
      return characterMcpSettings;
    }

    return undefined;
  }

  /**
   * Servers declared via the host environment as `MCP_SERVER_<NAME>_URL`, with
   * an optional `MCP_SERVER_<NAME>_TYPE` of `sse` or `http` (anything else
   * falls back to `streamable-http`). Env-declared servers still pass the same
   * security validation as configured ones.
   */
  private readEnvMcpServers(): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {};
    for (const [key, value] of Object.entries(process.env)) {
      const match = key.match(/^MCP_SERVER_(.+)_URL$/);
      if (!match || !value?.trim()) continue;
      const name = match[1].toLowerCase();
      const typeRaw = process.env[`MCP_SERVER_${match[1]}_TYPE`]?.trim().toLowerCase();
      const type = typeRaw === "http" || typeRaw === "sse" ? typeRaw : "streamable-http";
      servers[name] = { type, url: value.trim() };
    }
    return servers;
  }

  private async validateServerConfigs(
    serverConfigs: Readonly<Record<string, McpServerConfig>>
  ): Promise<Record<string, McpServerConfig>> {
    const validated: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(serverConfigs)) {
      const rejection = await validateMcpServerConfig(config as unknown as Record<string, unknown>);
      if (rejection) {
        throw new ElizaError(`MCP server "${name}" has an invalid or unsafe config`, {
          code: "MCP_SERVER_CONFIG_REJECTED",
          context: { server: name, rejection },
          severity: "fatal",
        });
      }
      validated[name] = config;
    }
    return validated;
  }

  private async updateServerConnections(
    serverConfigs: Readonly<Record<string, McpServerConfig>>
  ): Promise<void> {
    const safeConfigs = await this.validateServerConfigs(serverConfigs);
    const currentNames = new Set(this.connections.keys());
    const newNames = new Set(Object.keys(safeConfigs));

    for (const name of currentNames) {
      if (!newNames.has(name)) {
        await this.deleteConnection(name);
      }
    }

    const connectionPromises = Object.entries(safeConfigs).map(async ([name, config]) => {
      try {
        const currentConnection = this.connections.get(name);
        if (!currentConnection) {
          await this.initializeConnection(name, config);
        } else if (JSON.stringify(config) !== currentConnection.server.config) {
          await this.deleteConnection(name);
          await this.initializeConnection(name, config);
        }
      } catch (error) {
        // error-policy:J4 per-server containment — one unreachable server must
        // not abort its siblings' connections or fail McpService start. The
        // failed server surfaces as a visibly distinct disconnected entry (or
        // is absent when it never got a transport), and the failure lands in
        // RECENT_ERRORS via reportError.
        const partial = this.connections.get(name);
        if (partial && partial.server.status !== "connected") {
          partial.server.status = "disconnected";
          this.appendErrorMessage(partial, error instanceof Error ? error.message : String(error));
        }
        this.runtime.reportError("mcp.connect", error, { serverName: name });
      }
    });

    await Promise.all(connectionPromises);
  }

  private async initializeConnection(name: string, config: McpServerConfig): Promise<void> {
    await this.deleteConnection(name);
    const state: ConnectionState = {
      status: "connecting",
      reconnectAttempts: 0,
      consecutivePingFailures: 0,
    };
    this.connectionStates.set(name, state);

    const client = new Client({ name: "elizaOS", version: "1.0.0" }, { capabilities: {} });
    const transport: McpConnection["transport"] =
      config.type === "stdio"
        ? await this.buildStdioClientTransport(name, config)
        : await this.buildHttpClientTransport(name, config);

    const connection: McpConnection = {
      server: {
        name,
        config: JSON.stringify(config),
        status: "connecting",
      },
      client,
      transport,
    };
    this.connections.set(name, connection);
    this.setupTransportHandlers(name, connection, state);
    await client.connect(transport);

    const capabilities = client.getServerCapabilities();
    const tools = await this.fetchToolsList(name);
    const resources = capabilities?.resources ? await this.fetchResourcesList(name) : [];
    const resourceTemplates = capabilities?.resources
      ? await this.fetchResourceTemplatesList(name)
      : [];

    connection.server = {
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
    this.startPingMonitoring(name);
  }

  private setupTransportHandlers(
    name: string,
    connection: McpConnection,
    _state: ConnectionState
  ): void {
    const config = JSON.parse(connection.server.config) as McpServerConfig;
    const isHttpTransport = config.type !== "stdio";

    connection.transport.onerror = async (error): Promise<void> => {
      const errorMessage = error?.message ?? String(error);
      const lower = errorMessage.toLowerCase();
      // For HTTP transports the optional server→client stream (the long-lived
      // GET/SSE channel) routinely times out or disconnects on request/response
      // servers that never hold it open. That is benign and must not tear down
      // the working POST channel, so match the SDK's message variants
      // ("timeout" / "timed out" / "SSE error" / "SSE stream disconnected")
      // case-insensitively.
      const isExpectedTimeout =
        isHttpTransport &&
        (errorMessage === "undefined" ||
          errorMessage === "" ||
          lower.includes("sse error") ||
          lower.includes("sse stream disconnected") ||
          lower.includes("timeout") ||
          lower.includes("timed out"));

      if (!isExpectedTimeout) {
        logger.error({ error, serverName: name }, `Transport error for "${name}"`);
        connection.server.status = "disconnected";
        this.appendErrorMessage(connection, error.message);
      }

      if (!isHttpTransport) {
        this.handleDisconnection(name, error);
      }
    };

    connection.transport.onclose = async (): Promise<void> => {
      if (!isHttpTransport) {
        connection.server.status = "disconnected";
        this.handleDisconnection(name, new Error("Transport closed"));
      }
    };
  }

  private startPingMonitoring(name: string): void {
    const connection = this.connections.get(name);
    if (!connection) return;

    const config = JSON.parse(connection.server.config) as McpServerConfig;
    const isHttpTransport = config.type !== "stdio";

    if (isHttpTransport) {
      return;
    }

    const state = this.connectionStates.get(name);
    if (!state || !this.pingConfig.enabled) return;
    if (state.pingInterval) clearInterval(state.pingInterval);
    state.pingInterval = setInterval(() => {
      this.sendPing(name).catch((err: Error) => {
        // error-policy:J5 fire-and-forget ping; the rejection is observed in
        // handlePingFailure, which counts failures and drives disconnection.
        logger.warn({ error: err.message, serverName: name }, `Ping failed for ${name}`);
        this.handlePingFailure(name, err);
      });
    }, this.pingConfig.intervalMs);
  }

  private async sendPing(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`No connection for ping: ${name}`);

    await Promise.race([
      connection.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Ping timeout")), this.pingConfig.timeoutMs)
      ),
    ]);

    const state = this.connectionStates.get(name);
    if (state) state.consecutivePingFailures = 0;
  }

  private handlePingFailure(name: string, error: Error): void {
    const state = this.connectionStates.get(name);
    if (!state) return;
    state.consecutivePingFailures++;
    if (state.consecutivePingFailures >= this.pingConfig.failuresBeforeDisconnect) {
      this.handleDisconnection(name, error);
    }
  }

  private handleDisconnection(name: string, error: Error | unknown): void {
    const state = this.connectionStates.get(name);
    if (!state) return;
    state.status = "disconnected";
    state.lastError = error instanceof Error ? error : new Error(String(error));
    if (state.pingInterval) clearInterval(state.pingInterval);
    if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      return;
    }
    const delay = INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** state.reconnectAttempts;
    state.reconnectTimeout = setTimeout(async () => {
      state.reconnectAttempts++;
      const connection = this.connections.get(name);
      const config = connection?.server?.config;
      if (config) {
        try {
          await this.initializeConnection(name, JSON.parse(config));
        } catch (err) {
          // error-policy:J5 background reconnect; failure is observed in
          // handleDisconnection, which records lastError and backs off (capped).
          this.handleDisconnection(name, err);
        }
      }
    }, delay);
  }

  async deleteConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection) {
      const closeResults = await Promise.allSettled([
        connection.transport.close(),
        connection.client.close(),
      ]);
      this.connections.delete(name);
      for (const result of closeResults) {
        if (result.status === "rejected") {
          logger.warn(
            { error: result.reason, serverName: name },
            `Failed to close MCP connection resource for "${name}"`
          );
        }
      }
    }
    const state = this.connectionStates.get(name);
    if (state) {
      if (state.pingInterval) clearInterval(state.pingInterval);
      if (state.reconnectTimeout) clearTimeout(state.reconnectTimeout);
      this.connectionStates.delete(name);
    }
  }

  private getServerConnection(serverName: string): McpConnection | undefined {
    return this.connections.get(serverName);
  }

  private async buildStdioClientTransport(
    name: string,
    config: StdioMcpServerConfig
  ): Promise<StdioClientTransport> {
    if (!config.command) {
      throw new Error(`Missing command for stdio MCP server ${name}`);
    }

    const rejection = await validateMcpServerConfig({
      type: "stdio",
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      timeoutInMillis: config.timeoutInMillis,
    });
    if (rejection) {
      throw new Error(`MCP stdio server "${name}" rejected at spawn: ${rejection}`);
    }

    return new StdioClientTransport({
      command: config.command,
      args: config.args ? [...config.args] : undefined,
      env: {
        ...config.env,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
      stderr: "pipe",
      cwd: config.cwd,
    });
  }

  private async buildHttpClientTransport(
    name: string,
    config: HttpMcpServerConfig
  ): Promise<SSEClientTransport | StreamableHTTPClientTransport> {
    if (!config.url) {
      throw new Error(`Missing URL for HTTP MCP server ${name}`);
    }

    const rejection = await validateMcpServerConfig({
      type: config.type,
      url: config.url,
    });
    if (rejection) {
      throw new Error(`MCP remote server "${name}" rejected at connect: ${rejection}`);
    }

    const url = new URL(config.url);
    if (config.type === "streamable-http") {
      return new StreamableHTTPClientTransport(url, { fetch: guardedMcpFetch });
    }
    return new SSEClientTransport(url, { fetch: guardedMcpFetch });
  }

  private appendErrorMessage(connection: McpConnection, error: string): void {
    const newError = connection.server.error ? `${connection.server.error}\n${error}` : error;
    connection.server.error = newError;
  }

  private async fetchToolsList(serverName: string): Promise<Tool[]> {
    const connection = this.getServerConnection(serverName);
    if (!connection) {
      return [];
    }

    const response = await connection.client.listTools();

    const tools = (response?.tools ?? []).flatMap((tool) => {
      const processedTool = { ...tool };

      if (tool.inputSchema) {
        if (!this.compatibilityInitialized) {
          this.initializeToolCompatibility();
        }

        try {
          processedTool.inputSchema = this.applyToolCompatibility(
            tool.inputSchema as JSONSchema7
          ) as typeof tool.inputSchema;
        } catch (error) {
          // error-policy:J3 attacker-controlled MCP tool inputSchema; omit the
          // tool rather than RangeError the listing loop or forward the graph.
          logger.warn(
            {
              src: "plugin:mcp:service",
              serverName,
              tool: tool.name,
              error,
            },
            "MCP tool schema rejected as unbounded"
          );
          return [];
        }
      }

      return [processedTool];
    });

    return tools;
  }

  private async fetchResourcesList(serverName: string): Promise<Resource[]> {
    const connection = this.getServerConnection(serverName);
    if (!connection) {
      return [];
    }

    const response = await connection.client.listResources();
    return response?.resources ?? [];
  }

  private async fetchResourceTemplatesList(serverName: string): Promise<ResourceTemplate[]> {
    const connection = this.getServerConnection(serverName);
    if (!connection) {
      return [];
    }

    const response = await connection.client.listResourceTemplates();
    return response?.resourceTemplates ?? [];
  }

  public getServers(): McpServer[] {
    return Array.from(this.connections.values())
      .filter((conn) => !conn.server.disabled)
      .map((conn) => conn.server);
  }

  public getProviderData(): McpProvider {
    return this.mcpProvider;
  }

  public async callTool(
    serverName: string,
    toolName: string,
    toolArguments?: Readonly<Record<string, unknown>>
  ): Promise<CallToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`No connection found for server: ${serverName}`);
    }
    if (connection.server.disabled) {
      throw new Error(`Server "${serverName}" is disabled`);
    }

    let timeout = DEFAULT_MCP_TIMEOUT_SECONDS;
    const config = JSON.parse(connection.server.config) as McpServerConfig;
    if (config.type === "stdio" && config.timeoutInMillis) {
      timeout = config.timeoutInMillis;
    }

    const result = await connection.client.callTool(
      {
        name: toolName,
        arguments: toolArguments ? { ...toolArguments } : undefined,
      },
      undefined,
      { timeout }
    );
    if (!result.content) {
      throw new Error("Invalid tool result: missing content array");
    }
    return result as CallToolResult;
  }

  public async readResource(serverName: string, uri: string): Promise<McpResourceResponse> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`No connection found for server: ${serverName}`);
    }
    if (connection.server.disabled) {
      throw new Error(`Server "${serverName}" is disabled`);
    }
    return await connection.client.readResource({ uri });
  }

  public async restartConnection(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    const config = connection?.server?.config;
    if (config) {
      connection.server.status = "connecting";
      connection.server.error = "";
      await this.deleteConnection(serverName);
      await this.initializeConnection(serverName, JSON.parse(config));
    }
  }

  private initializeToolCompatibility(): void {
    if (this.compatibilityInitialized) return;

    this.toolCompatibility = createMcpToolCompatibility(this.runtime);
    this.compatibilityInitialized = true;
  }

  public applyToolCompatibility(toolSchema: JSONSchema7): JSONSchema7 {
    if (!this.compatibilityInitialized) {
      this.initializeToolCompatibility();
    }

    if (!this.toolCompatibility || !toolSchema) {
      return toolSchema;
    }

    return this.toolCompatibility.transformToolSchema(toolSchema);
  }
}
