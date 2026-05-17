/**
 * MCP (Model Context Protocol) Type Definitions
 *
 * Shared types for MCP server configuration and settings.
 */

/**
 * Configuration for a single MCP server.
 */
export interface McpServerConfig {
  type: "streamable-http" | "stdio";
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
