/**
 * External Agent Adapter
 *
 * Manages connections to external agents via A2A, MCP, or custom protocols.
 * Provides standard interface for interacting with external agents.
 *
 * @remarks
 * Features:
 * - JSON-RPC 2.0 A2A protocol support
 * - Multiple authentication methods (OAuth2, Bearer, API Key)
 * - Agent discovery via .well-known/agent-card.json
 * - Trust verification and scoring
 * - Streaming message support
 * - Connection pooling and retry logic
 *
 * @packageDocumentation
 */

import { createDecipheriv } from "node:crypto";
import { db } from "@polyagent/db";
import { logger } from "../shared/logger";
import type { AgentCard } from "../types/agent-registry";
import { TrustLevel } from "../types/agent-registry";
import type { JsonValue } from "../types/common";

// Re-export TrustLevel from types for backwards compatibility
export { TrustLevel } from "../types/agent-registry";

/**
 * Gets encryption key from environment
 * @internal
 */
const getEncryptionKey = () => {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("CRON_SECRET must be set in production");
  }
  return "dev-key-change-in-production-32-chars!!";
};

/** Encryption algorithm for API key storage */
const ALGORITHM = "aes-256-cbc";

export type Protocol = "a2a" | "mcp" | "agent0" | "custom";

export enum AuthMethod {
  NONE = "NONE",
  BEARER_TOKEN = "BEARER_TOKEN",
  API_KEY = "API_KEY",
  OAUTH2 = "OAUTH2",
  MUTUAL_TLS = "MUTUAL_TLS",
}

export interface ExternalAgentConnection {
  id: string;
  externalId: string;
  endpoint: string;
  protocol: Protocol;
  isHealthy: boolean;
  lastHealthCheck?: Date;
  lastConnected?: Date;
  authMethod?: AuthMethod;
  authToken?: string;
  agentCard?: AgentCard;
  trustLevel?: TrustLevel;
  trustScore?: number;
}

/**
 * Message interface for external agent communication
 *
 * @remarks
 * This is different from AgentMessage in types.ts which is for internal agent messaging.
 */
export interface ExternalAgentMessage {
  type: string;
  content: JsonValue;
  metadata?: Record<string, JsonValue>;
  contextId?: string;
  streaming?: boolean;
}

export interface AgentResponse {
  success: boolean;
  data?: JsonValue;
  error?: string;
  messageId?: string;
}

/**
 * JSON-RPC 2.0 request structure for A2A protocol
 * @internal
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, JsonValue>;
}

/**
 * JSON-RPC 2.0 response structure
 * @internal
 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

/**
 * Authentication credentials storage
 * @internal
 */
interface AuthCredentials {
  method: AuthMethod;
  token?: string;
  apiKey?: string;
  oauth?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    tokenType?: string;
  };
}

/**
 * External Agent Adapter
 *
 * Routes messages to external agents based on their protocol (A2A, MCP, Agent0, or custom).
 */
export class ExternalAgentAdapter {
  private connections: Map<string, ExternalAgentConnection> = new Map();
  private authStore: Map<string, AuthCredentials> = new Map();
  private discoveryCache: Map<string, { card: AgentCard; timestamp: number }> =
    new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private requestIdCounter = 0;
  private readonly DISCOVERY_CACHE_TTL = 300000;

  constructor(private healthCheckIntervalMs = 60000) {}

  /**
   * Initializes adapter and starts health checks
   */
  async initialize(): Promise<void> {
    await this.loadConnections();
    this.startHealthChecks();
  }

  /**
   * Loads all active external agent connections from database
   * @internal
   */
  private async loadConnections(): Promise<void> {
    const externalAgents = await db.query.externalAgentConnections.findMany({
      where: (externalAgentConnections, { eq }) =>
        eq(externalAgentConnections.isHealthy, true),
      with: {
        agentRegistry: true,
      },
    });

    for (const agent of externalAgents) {
      this.connections.set(agent.externalId, {
        id: agent.id,
        externalId: agent.externalId,
        endpoint: agent.endpoint,
        protocol: agent.protocol as Protocol,
        isHealthy: agent.isHealthy,
        lastConnected: agent.lastConnected ?? undefined,
      });

      // Load and decrypt authentication credentials if present
      if (agent.authType && agent.authCredentials) {
        const decryptedCredentials = this.decryptCredentials(
          agent.authCredentials,
        );
        // Map authType to AuthMethod and create appropriate credentials structure
        const authMethod = agent.authType as AuthMethod;
        const credentials: AuthCredentials = {
          method: authMethod,
          ...(authMethod === AuthMethod.BEARER_TOKEN ||
          authMethod === AuthMethod.API_KEY
            ? { token: decryptedCredentials, apiKey: decryptedCredentials }
            : {}),
        };
        this.configureAuth(agent.externalId, credentials);
      }
    }

    logger.info(
      `Loaded ${this.connections.size} external agent connections`,
      {},
      "ExternalAgentAdapter",
    );
  }

  /**
   * Fetch a single connection from DB and cache it
   */
  async fetchConnection(
    externalId: string,
  ): Promise<ExternalAgentConnection | null> {
    const agent = await db.externalAgentConnection.findUnique({
      where: { externalId },
      include: { AgentRegistry: true },
    });

    if (!agent) return null;

    const connection: ExternalAgentConnection = {
      id: agent.id,
      externalId: agent.externalId,
      endpoint: agent.endpoint,
      protocol: agent.protocol as Protocol,
      isHealthy: agent.isHealthy,
      lastConnected: agent.lastConnected ?? undefined,
    };

    this.connections.set(agent.externalId, connection);

    // Load and decrypt authentication credentials if present
    if (agent.authType && agent.authCredentials) {
      const decryptedCredentials = this.decryptCredentials(
        agent.authCredentials,
      );
      const authMethod = agent.authType as AuthMethod;
      const credentials: AuthCredentials = {
        method: authMethod,
        ...(authMethod === AuthMethod.BEARER_TOKEN ||
        authMethod === AuthMethod.API_KEY
          ? { token: decryptedCredentials, apiKey: decryptedCredentials }
          : {}),
      };
      this.configureAuth(agent.externalId, credentials);
    }

    return connection;
  }

  /**
   * Send message to external agent
   */
  async sendMessage(
    externalId: string,
    message: ExternalAgentMessage,
  ): Promise<AgentResponse> {
    let connection = this.connections.get(externalId);

    if (!connection) {
      // Try to fetch from DB (lazy load)
      connection = (await this.fetchConnection(externalId)) || undefined;
    }

    if (!connection) {
      return {
        success: false,
        error: `External agent not found: ${externalId}`,
      };
    }

    if (!connection.isHealthy) {
      return {
        success: false,
        error: `External agent unhealthy: ${externalId}`,
      };
    }

    // Route to appropriate protocol handler
    switch (connection.protocol) {
      case "a2a":
        return await this.sendA2AMessage(connection, message);
      case "mcp":
        return await this.sendMCPMessage(connection, message);
      case "agent0":
        return await this.sendAgent0Message(connection, message);
      case "custom":
        return await this.sendCustomMessage(connection, message);
      default:
        return {
          success: false,
          error: `Unsupported protocol: ${connection.protocol}`,
        };
    }
  }

  /**
   * Send A2A protocol message (JSON-RPC 2.0)
   */
  private async sendA2AMessage(
    connection: ExternalAgentConnection,
    message: ExternalAgentMessage,
  ): Promise<AgentResponse> {
    const requestId = ++this.requestIdCounter;
    const params: Record<string, JsonValue> = {
      parts: [
        {
          type: "text",
          content: message.content,
        },
      ],
    };
    if (message.contextId !== undefined) {
      params.contextId = message.contextId;
    }
    if (message.metadata !== undefined) {
      params.metadata = message.metadata;
    }
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method: "message/send",
      params,
    };

    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...this.getAuthHeaders(connection.externalId),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (!response.ok) {
      throw new Error(`A2A HTTP ${response.status}: ${response.statusText}`);
    }

    const jsonRpcResponse = (await response.json()) as JsonRpcResponse;

    if (jsonRpcResponse.error) {
      return {
        success: false,
        error: `A2A Error ${jsonRpcResponse.error.code}: ${jsonRpcResponse.error.message}`,
      };
    }

    return {
      success: true,
      data: jsonRpcResponse.result as JsonValue,
      messageId: String(jsonRpcResponse.id),
    };
  }

  /**
   * Send MCP protocol message
   */
  private async sendMCPMessage(
    connection: ExternalAgentConnection,
    message: ExternalAgentMessage,
  ): Promise<AgentResponse> {
    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: message.type,
        params: message.content,
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      return {
        success: false,
        error: data.error.message || "MCP error",
      };
    }

    return {
      success: true,
      data: data.result,
    };
  }

  /**
   * Send Agent0 SDK message
   */
  private async sendAgent0Message(
    connection: ExternalAgentConnection,
    message: ExternalAgentMessage,
  ): Promise<AgentResponse> {
    // Agent0 SDK typically uses REST API
    const response = await fetch(`${connection.endpoint}/api/agent/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Agent0 request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      success: true,
      data,
    };
  }

  /**
   * Send custom protocol message
   */
  private async sendCustomMessage(
    connection: ExternalAgentConnection,
    message: ExternalAgentMessage,
  ): Promise<AgentResponse> {
    // For custom protocols, use generic JSON POST
    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Custom request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      success: true,
      data,
    };
  }

  /**
   * Perform health check on external agent
   */
  async healthCheck(externalId: string): Promise<boolean> {
    const connection = this.connections.get(externalId);

    if (!connection) {
      return false;
    }

    const response = await fetch(connection.endpoint, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    const isHealthy = response.ok;
    connection.isHealthy = isHealthy;
    connection.lastHealthCheck = new Date();

    // Update database
    await db.externalAgentConnection.update({
      where: { externalId },
      data: {
        isHealthy,
        lastHealthCheck: new Date(),
      },
    });

    return isHealthy;
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      for (const [externalId] of this.connections) {
        await this.healthCheck(externalId);
      }
    }, this.healthCheckIntervalMs);

    logger.info(
      `Health checks started (interval: ${this.healthCheckIntervalMs}ms)`,
      undefined,
      "ExternalAgentAdapter",
    );
  }

  /**
   * Stop health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.info("Health checks stopped", undefined, "ExternalAgentAdapter");
    }
  }

  /**
   * Get connection status for external agent
   */
  getConnectionStatus(externalId: string): ExternalAgentConnection | undefined {
    return this.connections.get(externalId);
  }

  /**
   * Get all connections
   */
  getAllConnections(): ExternalAgentConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Refresh connections from database
   */
  async refreshConnections(): Promise<void> {
    await this.loadConnections();
  }

  /**
   * Configure authentication for external agent
   */
  configureAuth(externalId: string, credentials: AuthCredentials): void {
    this.authStore.set(externalId, credentials);
    logger.info(
      `Authentication configured for ${externalId}`,
      { method: credentials.method },
      "ExternalAgentAdapter",
    );
  }

  /**
   * Decrypt credentials from storage
   */
  private decryptCredentials(encrypted: string): string {
    const [ivHex, encryptedData] = encrypted.split(":");
    if (!ivHex || !encryptedData) {
      throw new Error("Invalid encrypted credentials format");
    }

    const iv = Buffer.from(ivHex, "hex");
    const key = Buffer.from(getEncryptionKey().padEnd(32).slice(0, 32));
    const decipher = createDecipheriv(ALGORITHM, key, iv);

    let decrypted = decipher.update(encryptedData, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Get authentication headers for agent
   */
  private getAuthHeaders(externalId: string): Record<string, string> {
    const auth = this.authStore.get(externalId);
    if (!auth || auth.method === AuthMethod.NONE) {
      return {};
    }

    switch (auth.method) {
      case AuthMethod.BEARER_TOKEN:
        return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
      case AuthMethod.API_KEY:
        return auth.apiKey ? { Authorization: auth.apiKey } : {};
      case AuthMethod.OAUTH2:
        return auth.oauth?.accessToken
          ? {
              Authorization: `${auth.oauth.tokenType || "Bearer"} ${auth.oauth.accessToken}`,
            }
          : {};
      default:
        return {};
    }
  }

  /**
   * Discover agent via .well-known/agent-card.json
   */
  async discoverAgent(endpoint: string): Promise<AgentCard | null> {
    // Check cache first
    const cached = this.discoveryCache.get(endpoint);
    if (cached && Date.now() - cached.timestamp < this.DISCOVERY_CACHE_TTL) {
      return cached.card;
    }

    try {
      const cardUrl = new URL(
        "/.well-known/agent-card.json",
        endpoint,
      ).toString();
      const response = await fetch(cardUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        logger.warn(
          `Agent discovery failed for ${endpoint}: HTTP ${response.status}`,
          undefined,
          "ExternalAgentAdapter",
        );
        return null;
      }

      const card = (await response.json()) as AgentCard;

      // Cache the result
      this.discoveryCache.set(endpoint, { card, timestamp: Date.now() });

      logger.info(
        `Discovered agent at ${endpoint}`,
        { agentId: card.agentId, name: card.name },
        "ExternalAgentAdapter",
      );
      return card;
    } catch (error) {
      logger.error(
        `Agent discovery failed for ${endpoint}`,
        { error: (error as Error).message },
        "ExternalAgentAdapter",
      );
      return null;
    }
  }

  /**
   * Calculate trust score for agent (0-100)
   */
  calculateTrustScore(connection: ExternalAgentConnection): number {
    let score = 0;

    // Base verification score (0-40 points)
    if (connection.trustLevel !== undefined) {
      score += connection.trustLevel * 10;
    }

    // Health status (0-20 points)
    if (connection.isHealthy) {
      score += 20;
    } else {
      score += 5; // Partial credit for registered but unhealthy
    }

    // Agent card presence (0-20 points)
    if (connection.agentCard) {
      score += 20;
    }

    // Connection history (0-20 points)
    if (connection.lastConnected) {
      const daysSinceConnection =
        (Date.now() - connection.lastConnected.getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysSinceConnection < 1) score += 20;
      else if (daysSinceConnection < 7) score += 15;
      else if (daysSinceConnection < 30) score += 10;
      else score += 5;
    }

    return Math.min(100, score);
  }

  /**
   * Verify agent and determine trust level
   */
  async verifyAgent(externalId: string): Promise<TrustLevel> {
    const connection = this.connections.get(externalId);
    if (!connection) {
      return TrustLevel.UNTRUSTED;
    }

    // Level 0: UNTRUSTED (no verification)
    let trustLevel = TrustLevel.UNTRUSTED;

    // Level 1: BASIC (endpoint reachable + agent card valid)
    const isHealthy = await this.healthCheck(externalId);
    if (isHealthy) {
      const agentCard = await this.discoverAgent(connection.endpoint);
      if (agentCard) {
        connection.agentCard = agentCard;
        trustLevel = TrustLevel.BASIC;
      }
    }

    // Level 2: VERIFIED (capability verification - simplified for now)
    if (trustLevel === TrustLevel.BASIC && connection.agentCard?.capabilities) {
      trustLevel = TrustLevel.VERIFIED;
    }

    // Update connection with trust info
    connection.trustLevel = trustLevel;
    connection.trustScore = this.calculateTrustScore(connection);

    logger.info(
      `Verified agent ${externalId}`,
      { trustLevel, trustScore: connection.trustScore },
      "ExternalAgentAdapter",
    );

    return trustLevel;
  }

  /**
   * Cleanup and shutdown
   */
  shutdown(): void {
    this.stopHealthChecks();
    this.connections.clear();
    this.authStore.clear();
    this.discoveryCache.clear();
    logger.info(
      "ExternalAgentAdapter shutdown complete",
      undefined,
      "ExternalAgentAdapter",
    );
  }
}

// Singleton instance
let adapterInstance: ExternalAgentAdapter | null = null;

/**
 * Get singleton ExternalAgentAdapter instance
 */
export function getExternalAgentAdapter(): ExternalAgentAdapter {
  if (!adapterInstance) {
    adapterInstance = new ExternalAgentAdapter();
    // Initialize asynchronously (don't block)
    adapterInstance.initialize().catch((error) => {
      logger.error(
        "Failed to initialize ExternalAgentAdapter",
        error instanceof Error ? error : new Error(String(error)),
        "ExternalAgentAdapter",
      );
    });
  }
  return adapterInstance;
}
