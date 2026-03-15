import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { GatewayClient } from "./gateway-client.js";
import {
  type AcpSessionStore,
  createInMemorySessionStore,
  createPersistentSessionStore,
} from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import type {
  ACPServiceConfig,
  AcpServerOptions,
  EventFrame,
} from "./types.js";

/**
 * Service type identifier for the ACPService
 */
export const ACP_SERVICE_TYPE = "acp";

/**
 * ACPService - Runtime service for Agent Client Protocol integration
 *
 * This service provides:
 * - ACP server functionality for IDE integration
 * - Session management for ACP connections
 * - Gateway bridge translation
 *
 * @example
 * ```typescript
 * // Get the service from runtime
 * const service = runtime.getService<ACPService>(ACP_SERVICE_TYPE);
 *
 * // Start ACP server
 * service?.startServer({ gatewayUrl: 'ws://localhost:18789' });
 * ```
 */
export class ACPService extends Service {
  static serviceType = ACP_SERVICE_TYPE;

  capabilityDescription =
    "Agent Client Protocol (ACP) service for IDE integration and gateway bridging";

  private acpConfig: ACPServiceConfig;
  private sessionStore: AcpSessionStore;
  private agent: AcpGatewayAgent | null = null;
  private gateway: GatewayClient | null = null;
  private isRunning = false;

  constructor(runtime?: IAgentRuntime, acpConfig: ACPServiceConfig = {}) {
    super(runtime);
    this.acpConfig = acpConfig;
    
    // Create session store based on configuration
    if (acpConfig.persistSessions) {
      this.sessionStore = createPersistentSessionStore({
        storePath: acpConfig.sessionStorePath,
        agentId: acpConfig.agentId ?? runtime?.agentId,
        loadOnCreate: true,
      });
      logger.info("[ACPService] Using persistent session store");
    } else {
      this.sessionStore = createInMemorySessionStore();
    }
  }

  /**
   * Start the ACPService
   */
  static async start(runtime: IAgentRuntime): Promise<ACPService> {
    const acpConfig = ACPService.loadConfigFromEnv();
    const service = new ACPService(runtime, acpConfig);
    await service.initialize();
    return service;
  }

  /**
   * Stop the ACPService
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = await runtime.getService<ACPService>(ACP_SERVICE_TYPE);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Load configuration from environment variables
   */
  private static loadConfigFromEnv(): ACPServiceConfig {
    return {
      gatewayUrl: process.env.ACP_GATEWAY_URL,
      gatewayToken: process.env.ACP_GATEWAY_TOKEN,
      gatewayPassword: process.env.ACP_GATEWAY_PASSWORD,
      defaultSessionKey: process.env.ACP_DEFAULT_SESSION_KEY,
      defaultSessionLabel: process.env.ACP_DEFAULT_SESSION_LABEL,
      requireExistingSession: process.env.ACP_REQUIRE_EXISTING === "true",
      resetSession: process.env.ACP_RESET_SESSION === "true",
      prefixCwd: process.env.ACP_PREFIX_CWD !== "false",
      verbose: process.env.ACP_VERBOSE === "true",
      clientName: process.env.ACP_CLIENT_NAME || "elizaos-acp",
      clientDisplayName: process.env.ACP_CLIENT_DISPLAY_NAME || "elizaOS ACP",
      clientVersion: process.env.ACP_CLIENT_VERSION || "1.0.0",
      clientMode: process.env.ACP_CLIENT_MODE || "cli",
      // Session persistence options
      persistSessions: process.env.ACP_PERSIST_SESSIONS === "true",
      sessionStorePath: process.env.ACP_SESSION_STORE_PATH,
      agentId: process.env.ACP_AGENT_ID,
    };
  }

  /**
   * Initialize the service
   */
  private async initialize(): Promise<void> {
    logger.info("[ACPService] Service initialized");
  }

  /**
   * Stop the service and clean up resources
   */
  async stop(): Promise<void> {
    if (this.isRunning) {
      this.isRunning = false;
      this.sessionStore.clearAllSessionsForTest();
      this.agent = null;
      this.gateway = null;
      logger.info("[ACPService] Service stopped");
    }
  }

  /**
   * Get the session store
   */
  getSessionStore(): AcpSessionStore {
    return this.sessionStore;
  }

  /**
   * Get the current configuration
   */
  getConfig(): ACPServiceConfig {
    return { ...this.acpConfig };
  }

  /**
   * Update the service configuration
   */
  updateConfig(config: Partial<ACPServiceConfig>): void {
    this.acpConfig = { ...this.acpConfig, ...config };
  }

  /**
   * Start the ACP server with stdin/stdout communication
   * This is used for IDE integration via stdio
   */
  startServer(opts: AcpServerOptions = {}): void {
    const mergedOpts = this.mergeOptions(opts);

    const gatewayUrl = mergedOpts.gatewayUrl || "ws://127.0.0.1:18789";

    this.gateway = new GatewayClient({
      url: gatewayUrl,
      token: mergedOpts.gatewayToken,
      password: mergedOpts.gatewayPassword,
      clientName: this.acpConfig.clientName,
      clientDisplayName: this.acpConfig.clientDisplayName,
      clientVersion: this.acpConfig.clientVersion,
      mode: this.acpConfig.clientMode,
      onEvent: (evt: EventFrame) => {
        void this.agent?.handleGatewayEvent(evt);
      },
      onHelloOk: () => {
        this.agent?.handleGatewayReconnect();
      },
      onClose: (code: number, reason: string) => {
        this.agent?.handleGatewayDisconnect(`${code}: ${reason}`);
      },
    });

    const input = Writable.toWeb(process.stdout);
    const output = Readable.toWeb(
      process.stdin,
    ) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    new AgentSideConnection((conn: AgentSideConnection) => {
      this.agent = new AcpGatewayAgent(conn, this.gateway!, {
        ...mergedOpts,
        sessionStore: this.sessionStore,
      });
      this.agent.start();
      return this.agent;
    }, stream);

    this.gateway.start();
    this.isRunning = true;

    logger.info(
      `[ACPService] ACP server started, connecting to gateway at ${gatewayUrl}`,
    );
  }

  /**
   * Check if the server is currently running
   */
  isServerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Create a new ACP gateway agent for custom use
   */
  createAgent(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpServerOptions = {},
  ): AcpGatewayAgent {
    const mergedOpts = this.mergeOptions(opts);
    return new AcpGatewayAgent(connection, gateway, {
      ...mergedOpts,
      sessionStore: this.sessionStore,
    });
  }

  /**
   * Create a gateway client with service configuration
   */
  createGatewayClient(
    url: string,
    callbacks: {
      onEvent?: (evt: EventFrame) => void;
      onHelloOk?: () => void;
      onClose?: (code: number, reason: string) => void;
    } = {},
  ): GatewayClient {
    return new GatewayClient({
      url,
      token: this.acpConfig.gatewayToken,
      password: this.acpConfig.gatewayPassword,
      clientName: this.acpConfig.clientName,
      clientDisplayName: this.acpConfig.clientDisplayName,
      clientVersion: this.acpConfig.clientVersion,
      mode: this.acpConfig.clientMode,
      ...callbacks,
    });
  }

  /**
   * Merge provided options with service configuration
   */
  private mergeOptions(opts: AcpServerOptions): AcpServerOptions {
    return {
      gatewayUrl: opts.gatewayUrl ?? this.acpConfig.gatewayUrl,
      gatewayToken: opts.gatewayToken ?? this.acpConfig.gatewayToken,
      gatewayPassword: opts.gatewayPassword ?? this.acpConfig.gatewayPassword,
      defaultSessionKey:
        opts.defaultSessionKey ?? this.acpConfig.defaultSessionKey,
      defaultSessionLabel:
        opts.defaultSessionLabel ?? this.acpConfig.defaultSessionLabel,
      requireExistingSession:
        opts.requireExistingSession ?? this.acpConfig.requireExistingSession,
      resetSession: opts.resetSession ?? this.acpConfig.resetSession,
      prefixCwd: opts.prefixCwd ?? this.acpConfig.prefixCwd,
      verbose: opts.verbose ?? this.acpConfig.verbose,
    };
  }
}

/**
 * Extended options for standalone ACP gateway
 */
export type ServeAcpGatewayOptions = AcpServerOptions & {
  /** Use persistent session store */
  persistSessions?: boolean;
  /** Path to session store file */
  sessionStorePath?: string;
  /** Agent ID for scoping sessions */
  agentId?: string;
};

/**
 * Standalone function to serve ACP gateway (for CLI usage)
 */
export function serveAcpGateway(opts: ServeAcpGatewayOptions = {}): void {
  const gatewayUrl = opts.gatewayUrl || "ws://127.0.0.1:18789";

  // Create session store based on options
  const sessionStore = opts.persistSessions
    ? createPersistentSessionStore({
        storePath: opts.sessionStorePath,
        agentId: opts.agentId,
        loadOnCreate: true,
      })
    : createInMemorySessionStore();

  let agent: AcpGatewayAgent | null = null;

  const gateway = new GatewayClient({
    url: gatewayUrl,
    token: opts.gatewayToken,
    password: opts.gatewayPassword,
    clientName: "elizaos-acp",
    clientDisplayName: "elizaOS ACP",
    clientVersion: "1.0.0",
    mode: "cli",
    onEvent: (evt: EventFrame) => {
      void agent?.handleGatewayEvent(evt);
    },
    onHelloOk: () => {
      agent?.handleGatewayReconnect();
    },
    onClose: (code: number, reason: string) => {
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
    },
  });

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(
    process.stdin,
  ) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  new AgentSideConnection((conn: AgentSideConnection) => {
    agent = new AcpGatewayAgent(conn, gateway, {
      ...opts,
      sessionStore,
    });
    agent.start();
    return agent;
  }, stream);

  gateway.start();

  if (opts.persistSessions) {
    logger.info("[ACP] Using persistent session store");
  }
}
