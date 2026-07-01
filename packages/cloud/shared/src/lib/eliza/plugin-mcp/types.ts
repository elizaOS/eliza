import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const MCP_SERVICE_NAME = "mcp";
export const DEFAULT_MCP_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_RECONNECT_ATTEMPTS = 5;
export const BACKOFF_MULTIPLIER = 2;
export const INITIAL_RETRY_DELAY = 2000;

export const DEFAULT_PING_CONFIG: PingConfig = {
  enabled: true,
  intervalMs: 10000,
  timeoutMs: 5000,
  failuresBeforeDisconnect: 3,
};

// ─── Server Configuration ────────────────────────────────────────────────────

export interface StdioMcpServerConfig {
  type: "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutInMillis?: number;
}

export interface HttpMcpServerConfig {
  type: "streamable-http";
  url: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpSettings {
  servers: Record<string, McpServerConfig>;
  maxRetries?: number;
}

// ─── Connection State ────────────────────────────────────────────────────────

export interface PingConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  failuresBeforeDisconnect: number;
}

export interface ConnectionState {
  status: "connecting" | "connected" | "disconnected" | "failed";
  pingInterval?: ReturnType<typeof setInterval>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
  lastConnected?: Date;
  lastError?: Error;
  consecutivePingFailures: number;
}

export type McpServerStatus = "connecting" | "connected" | "disconnected";

export interface McpServer {
  name: string;
  status: McpServerStatus;
  config: string;
  error?: string;
  disabled?: boolean;
  tools?: Tool[];
  resources?: Resource[];
  resourceTemplates?: ResourceTemplate[];
}

export interface McpConnection {
  server: McpServer;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

// ─── Provider Data ───────────────────────────────────────────────────────────

export interface McpToolInfo {
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceInfo {
  name: string;
  description: string;
  mimeType?: string;
}

export interface McpServerInfo {
  status: string;
  tools: Record<string, McpToolInfo>;
  resources: Record<string, McpResourceInfo>;
}

export interface McpProviderData {
  [serverName: string]: McpServerInfo;
}

export interface McpProvider {
  values: { mcp: McpProviderData; mcpText?: string };
  data: { mcp: McpProviderData };
  text: string;
}

// ─── Schema Cache ────────────────────────────────────────────────────────────

export interface McpSchemaCacheConfig {
  enabled: boolean;
  redisUrl?: string;
  redisToken?: string;
  ttlSeconds: number;
}

export interface CachedToolSchema {
  name: string;
  description?: string;
  inputSchema?: Tool["inputSchema"];
}

export interface CachedServerSchema {
  serverName: string;
  tools: CachedToolSchema[];
  cachedAt: number;
  configHash: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type ValidationResult<T> = { success: true; data: T } | { success: false; error: string };

export const ResourceSelectionSchema = {
  type: "object",
  oneOf: [{ required: ["serverName", "uri"] }, { required: ["noResourceAvailable"] }],
  properties: {
    serverName: { type: "string", minLength: 1 },
    uri: { type: "string", minLength: 1 },
    reasoning: { type: "string" },
    noResourceAvailable: { type: "boolean" },
  },
};
