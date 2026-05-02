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
    const mcpSettings = this.getMcpSettings();

    if (!mcpSettings || !mcpSettings.servers || Object.keys(mcpSettings.servers).length === 0) {
      this.mcpProvider = buildMcpProviderData([]);
      return;
    }

    await this.updateServerConnections(mcpSettings.servers);
    const servers = this.getServers();
    this.mcpProvider = buildMcpProviderData(servers);
  }

  private getMcpSettings(): McpSettings | undefined {
    const rawSettings = this.runtime.getSetting("mcp");
    let settings: McpSettings | null | undefined = null;

    if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
      const parsed = rawSettings as Record<string, unknown>;
      if ("servers" in parsed && typeof parsed.servers === "object" && parsed.servers !== null) {
        settings = parsed as unknown as McpSettings;
      }
    }

    if (!settings || !settings.servers) {
      const characterSettings = this.runtime.character.settings;
      if (
        characterSettings &&
        typeof characterSettings === "object" &&
        "mcp" in characterSettings
      ) {
        const characterMcpSettings = characterSettings.mcp;
        if (
          characterMcpSettings &&
          typeof characterMcpSettings === "object" &&
          "servers" in characterMcpSettings
        ) {
          settings = characterMcpSettings as unknown as McpSettings;
        }
      }
    }

    if (settings && typeof settings === "object" && settings.servers) {
      return settings;
    }

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
      }
    }

    const connectionPromises = Object.entries(serverConfigs).map(async ([name, config]) => {
      const currentConnection = this.connections.get(name);
      if (!currentConnection) {
        await this.initializeConnection(name, config);
      } else if (JSON.stringify(config) !== currentConnection.server.config) {
        await this.deleteConnection(name);
        await this.initializeConnection(name, config);
      }
    });

    await Promise.allSettled(connectionPromises);
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
      const isExpectedTimeout =
        isHttpTransport &&
        (errorMessage === "undefined" ||
          errorMessage === "" ||
          errorMessage.includes("SSE error") ||
          errorMessage.includes("timeout"));

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
      }

      return processedTool;
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
