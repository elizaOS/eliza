import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  EmbeddedResource,
  ImageContent,
  Resource,
  ResourceTemplate,
  TextContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const MCP_SERVICE_NAME = "mcp" as const;
export const DEFAULT_MCP_TIMEOUT_SECONDS = 60000;
export const MIN_MCP_TIMEOUT_SECONDS = 1;
export const DEFAULT_MAX_RETRIES = 2;

export interface PingConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly failuresBeforeDisconnect: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "failed";

export interface ConnectionState {
  status: ConnectionStatus;
  pingInterval?: ReturnType<typeof setInterval>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
  lastConnected?: Date;
  lastError?: Error;
  consecutivePingFailures: number;
}

export interface StdioMcpServerConfig {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutInMillis?: number;
}

export interface HttpMcpServerConfig {
  readonly type: "http" | "streamable-http" | "sse";
  readonly url: string;
  readonly timeout?: number;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpSettings {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly maxRetries?: number;
}

export type McpServerStatus = "connecting" | "connected" | "disconnected";

export interface McpServer {
  readonly name: string;
  status: McpServerStatus;
  readonly config: string;
  error?: string;
  disabled?: boolean;
  tools?: readonly Tool[];
  resources?: readonly Resource[];
  resourceTemplates?: readonly ResourceTemplate[];
}

export interface McpConnection {
  server: McpServer;
  readonly client: Client;
  readonly transport: StdioClientTransport | SSEClientTransport;
}

export interface McpToolResult {
  readonly content: ReadonlyArray<TextContent | ImageContent | EmbeddedResource>;
  readonly isError?: boolean;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface McpResourceResponse {
  readonly contents: readonly McpResourceContent[];
}

export interface McpToolInputSchema {
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly [key: string]:
    | JsonSchemaValue
    | Readonly<Record<string, JsonSchemaProperty>>
    | readonly string[]
    | undefined;
}

export interface McpToolInfo {
  readonly description: string;
  readonly inputSchema?: McpToolInputSchema;
}

export interface McpResourceInfo {
  readonly name: string;
  readonly description: string;
  readonly mimeType?: string;
}

export interface McpServerInfo {
  readonly status: string;
  readonly tools: Readonly<Record<string, McpToolInfo>>;
  readonly resources: Readonly<Record<string, McpResourceInfo>>;
}

export interface McpProviderData {
  readonly [serverName: string]: McpServerInfo;
}

export interface McpProviderValues {
  readonly mcp: McpProviderData;
  readonly mcpText?: string;
}

export interface McpProvider {
  readonly values: McpProviderValues;
  readonly data: { readonly mcp: McpProviderData };
  readonly text: string;
}

export type JsonSchemaPrimitive = string | number | boolean | null;
export type JsonSchemaValue = JsonSchemaPrimitive | JsonSchemaObject | JsonSchemaArray;
export interface JsonSchemaObject {
  readonly [key: string]: JsonSchemaValue;
}
export type JsonSchemaArray = readonly JsonSchemaValue[];

export interface JsonSchemaProperty {
  readonly type?: string;
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchemaProperty;
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly [key: string]:
    | JsonSchemaValue
    | JsonSchemaProperty
    | Readonly<Record<string, JsonSchemaProperty>>
    | readonly string[]
    | undefined;
}

export const ToolSelectionSchema = {
  type: "object",
  required: ["serverName", "toolName", "arguments"],
  properties: {
    serverName: {
      type: "string",
      minLength: 1,
      errorMessage: "serverName must not be empty",
    },
    toolName: {
      type: "string",
      minLength: 1,
      errorMessage: "toolName must not be empty",
    },
    arguments: {
      type: "object",
    },
    reasoning: {
      type: "string",
    },
    noToolAvailable: {
      type: "boolean",
    },
  },
} as const;

export const ResourceSelectionSchema = {
  type: "object",
  required: ["serverName", "uri"],
  properties: {
    serverName: {
      type: "string",
      minLength: 1,
      errorMessage: "serverName must not be empty",
    },
    uri: {
      type: "string",
      minLength: 1,
      errorMessage: "uri must not be empty",
    },
    reasoning: {
      type: "string",
    },
    noResourceAvailable: {
      type: "boolean",
    },
  },
} as const;

export const DEFAULT_PING_CONFIG: Readonly<PingConfig> = {
  enabled: true,
  intervalMs: 10000,
  timeoutMs: 5000,
  failuresBeforeDisconnect: 3,
} as const;

export const MAX_RECONNECT_ATTEMPTS = 5;
export const BACKOFF_MULTIPLIER = 2;
export const INITIAL_RETRY_DELAY = 2000;

interface SuccessResult<T> {
  readonly success: true;
  readonly data: T;
}

interface ErrorResult {
  readonly success: false;
  readonly error: string;
}

export type ValidationResult<T> = SuccessResult<T> | ErrorResult;

export function assertNonNull<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

export function assertString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

export function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
