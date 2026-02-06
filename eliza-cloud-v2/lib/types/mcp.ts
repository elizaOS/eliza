/**
 * MCP (Model Context Protocol) Type Definitions
 *
 * Shared types for MCP server configuration and settings.
 */

/**
 * Configuration for a single MCP server.
 */
export interface McpServerConfig {
  type: "http" | "sse" | "streamable-http";
  url: string;
  timeout?: number;
}

/**
 * MCP settings containing multiple server configurations.
 */
export interface McpSettings {
  servers: Record<string, McpServerConfig>;
  maxRetries?: number;
}
