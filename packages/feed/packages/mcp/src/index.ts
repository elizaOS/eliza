/**
 * @packageDocumentation
 * @module @feed/mcp
 *
 * MCP Protocol Implementation for Feed
 *
 * Feed implements the Model Context Protocol (MCP) following JSON-RPC 2.0 specification.
 * This package provides a complete MCP server implementation for agent discovery and tool execution.
 *
 * @example
 * ```typescript
 * import { MCPRequestHandler } from '@feed/mcp';
 *
 * const handler = new MCPRequestHandler();
 * const response = await handler.handle({
 *   jsonrpc: '2.0',
 *   method: 'tools/list',
 *   id: 1
 * });
 * ```
 *
 * @see {@link https://modelcontextprotocol.io | MCP Specification}
 */

export * from './auth';
export * from './handlers';
export * from './server';
export * from './types';
export * from './utils';
