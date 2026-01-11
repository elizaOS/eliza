import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

interface RuntimeCharacter {
  settings?: {
    mcp?: McpSettings;
  };
}

interface RuntimeWithSettings {
  character?: RuntimeCharacter;
  settings?: {
    mcp?: McpSettings;
  };
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

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    logger.info("[McpService] Constructor called, starting initialization...");
    this.initializationPromise = this.initializeMcpServers();
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
    logger.info("[McpService] Starting MCP server initialization...");
    const mcpSettings = this.getMcpSettings();
    const serverCount = mcpSettings?.servers ? Object.keys(mcpSettings.servers).length : 0;
    const serverNames = mcpSettings?.servers ? Object.keys(mcpSettings.servers) : [];
    logger.info(
      `[McpService] Getting MCP settings... hasSettings=${!!mcpSettings} hasServers=${!!mcpSettings?.servers} serverCount=${serverCount} servers=${JSON.stringify(serverNames)}`
    );

    if (!mcpSettings || !mcpSettings.servers || Object.keys(mcpSettings.servers).length === 0) {
      logger.info("[McpService] No MCP servers configured.");
      this.mcpProvider = buildMcpProviderData([]);
      return;
    }

    logger.info(
      `[McpService] Connecting to ${Object.keys(mcpSettings.servers).length} MCP servers: ${JSON.stringify(Object.keys(mcpSettings.servers))}`
    );

    const connectionStartTime = Date.now();
    await this.updateServerConnections(mcpSettings.servers);
    const connectionDuration = Date.now() - connectionStartTime;

    const servers = this.getServers();
    const connectedServers = servers.filter((s) => s.status === "connected");
    const failedServers = servers.filter((s) => s.status !== "connected");

    if (connectedServers.length > 0) {
      const toolCounts = connectedServers
        .map((s) => `${s.name}:${s.tools?.length ?? 0}tools`)
        .join(", ");
      logger.info(
        `[McpService] ✓ Successfully connected ${connectedServers.length}/${servers.length} servers in ${connectionDuration}ms: ${toolCounts}`
      );
    }

    if (failedServers.length > 0) {
      const failedDetails = failedServers
        .map((s) => `${s.name}(${s.error ?? "unknown error"})`)
        .join(", ");
      logger.warn(
        `[McpService] ⚠️  Failed to connect to ${failedServers.length}/${servers.length} servers: ${failedDetails}`
      );
    }

    if (connectedServers.length === 0 && servers.length > 0) {
      logger.error(
        `[McpService] ❌ ALL MCP servers failed to connect! MCP tools will NOT be available.`
      );
    }

    this.mcpProvider = buildMcpProviderData(servers);
    const mcpDataKeys = Object.keys(this.mcpProvider.data.mcp ?? {});
    logger.info(`[McpService] MCP provider data built: ${mcpDataKeys.length} server(s) available`);
  }

  private getMcpSettings(): McpSettings | undefined {
    const rawSettings = this.runtime.getSetting("mcp");
    let settings = rawSettings as unknown as McpSettings | null | undefined;
    logger.info(
      `[McpService] getSetting("mcp") result: type=${typeof rawSettings} isNull=${rawSettings === null} hasServers=${!!(settings?.servers)}`
    );

    if (!settings || !settings.servers) {
      const runtimeWithSettings = this.runtime as unknown as RuntimeWithSettings;
      const characterSettings = runtimeWithSettings.character?.settings;
      if (characterSettings?.mcp) {
        logger.info("[McpService] Found MCP settings in character.settings.mcp (fallback)");
        settings = characterSettings.mcp;
      }
    }

    if (!settings || !settings.servers) {
      const runtimeWithSettings = this.runtime as unknown as RuntimeWithSettings;
      if (runtimeWithSettings.settings?.mcp) {
        logger.info("[McpService] Found MCP settings in runtime.settings.mcp (fallback)");
        settings = runtimeWithSettings.settings.mcp;
      }
    }

    if (settings && typeof settings === "object" && settings.servers) {
      logger.info(
        `[McpService] MCP settings found with ${Object.keys(settings.servers).length} server(s)`
      );
      return settings;
    }

    logger.info("[McpService] No valid MCP settings found");
    return undefined;
  }

  private async updateServerConnections(
    serverConfigs: Readonly<Record<string, McpServerConfig>>
  ): Promise<void> {
    const currentNames = new Set(this.connections.keys());
    const newNames = new Set(Object.keys(serverConfigs));

    for (const name of currentNames) {
      if (!newNames.has(name)) {
        await this.deleteConnection(name);
        logger.info(`Deleted MCP server: ${name}`);
      }
    }

    const connectionPromises = Object.entries(serverConfigs).map(async ([name, config]) => {
      const currentConnection = this.connections.get(name);
      if (!currentConnection) {
        await this.initializeConnection(name, config);
        logger.info(`✓ Connected to MCP server: ${name}`);
      } else if (JSON.stringify(config) !== currentConnection.server.config) {
        await this.deleteConnection(name);
        await this.initializeConnection(name, config);
        logger.info(`✓ Reconnected MCP server with updated config: ${name}`);
      }
    });

    await Promise.allSettled(connectionPromises);
    logger.info(`[McpService] All server connection attempts completed`);
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
    const transport: StdioClientTransport | SSEClientTransport =
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
    logger.debug(`[${name}] Server capabilities:`, JSON.stringify(capabilities ?? {}));

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
    logger.info(`Successfully connected to MCP server: ${name}`);
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
      const isExpectedTimeout =
        isHttpTransport &&
        (errorMessage === "undefined" ||
          errorMessage === "" ||
          errorMessage.includes("SSE error") ||
          errorMessage.includes("timeout"));

      if (isExpectedTimeout) {
        logger.debug(
          { serverName: name },
          `SSE connection timeout for "${name}" (expected, will reconnect)`
        );
      } else {
        logger.error({ error, serverName: name }, `Transport error for "${name}"`);
        connection.server.status = "disconnected";
        this.appendErrorMessage(connection, error.message);
      }

      if (!isHttpTransport) {
        this.handleDisconnection(name, error);
      }
    };

    connection.transport.onclose = async (): Promise<void> => {
      if (isHttpTransport) {
        logger.debug(
          { serverName: name },
          `SSE connection closed for "${name}" (stateless, will reconnect on demand)`
        );
      } else {
        logger.warn({ serverName: name }, `Transport closed for "${name}"`);
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
      logger.debug(`[McpService] Skipping ping monitoring for HTTP server: ${name}`);
      return;
    }

    const state = this.connectionStates.get(name);
    if (!state || !this.pingConfig.enabled) return;
    if (state.pingInterval) clearInterval(state.pingInterval);
    state.pingInterval = setInterval(() => {
      this.sendPing(name).catch((err: Error) => {
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
      logger.warn(`Ping failures exceeded for ${name}, disconnecting and attempting reconnect.`);
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
      logger.error(`Max reconnect attempts reached for ${name}. Giving up.`);
      return;
    }
    const delay = INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** state.reconnectAttempts;
    state.reconnectTimeout = setTimeout(async () => {
      state.reconnectAttempts++;
      logger.info(`Attempting to reconnect to ${name} (attempt ${state.reconnectAttempts})...`);
      const connection = this.connections.get(name);
      const config = connection?.server?.config;
      if (config) {
        try {
          await this.initializeConnection(name, JSON.parse(config));
        } catch (err) {
          logger.error(
            {
              error: err instanceof Error ? err.message : String(err),
              serverName: name,
            },
            `Reconnect attempt failed for ${name}`
          );
          this.handleDisconnection(name, err);
        }
      }
    }, delay);
  }

  async deleteConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection) {
      await connection.transport.close();
      await connection.client.close();
      this.connections.delete(name);
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
  ): Promise<SSEClientTransport> {
    if (!config.url) {
      throw new Error(`Missing URL for HTTP MCP server ${name}`);
    }

    if (config.type === "sse") {
      logger.warn(
        `Server "${name}": "sse" transport type is deprecated. Use "streamable-http" or "http" instead for the modern Streamable HTTP transport.`
      );
    }

    return new SSEClientTransport(new URL(config.url));
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

    const tools = (response?.tools ?? []).map((tool) => {
      const processedTool = { ...tool };

      if (tool.inputSchema) {
        if (!this.compatibilityInitialized) {
          this.initializeToolCompatibility();
        }

        processedTool.inputSchema = this.applyToolCompatibility(
          tool.inputSchema as JSONSchema7
        ) as typeof tool.inputSchema;
        logger.debug(`Applied tool compatibility for: ${tool.name} on server: ${serverName}`);
      }

      return processedTool;
    });

    logger.info(`Fetched ${tools.length} tools for ${serverName}`);
    for (const tool of tools) {
      logger.info(`[${serverName}] ${tool.name}: ${tool.description}`);
    }

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
      logger.info(`Restarting ${serverName} MCP server...`);
      connection.server.status = "connecting";
      connection.server.error = "";
      await this.deleteConnection(serverName);
      await this.initializeConnection(serverName, JSON.parse(config));
      logger.info(`${serverName} MCP server connected`);
    }
  }

  private initializeToolCompatibility(): void {
    if (this.compatibilityInitialized) return;

    this.toolCompatibility = createMcpToolCompatibility(this.runtime);
    this.compatibilityInitialized = true;

    if (this.toolCompatibility) {
      logger.info(`Tool compatibility enabled`);
    } else {
      logger.info(`No tool compatibility needed`);
    }
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
