/**
 * MCP Request Handler
 *
 * Handles JSON-RPC 2.0 requests for MCP protocol methods
 * Similar to A2A's JsonRpcTransportHandler
 */

import type { JsonValue, StringRecord } from '@babylon/shared';
import { authenticateAgent } from '../auth/agent-auth';
import { getAvailableTools, getInitializeResult } from '../server/mcp-server';
import type {
  InitializeParams,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
  MCPAuthContext,
  ToolCallParams,
  ToolCallResult,
  ToolsListResult,
} from '../types/mcp';
import { MCPMethod } from '../types/mcp';
import { executeTool } from './tool-handlers';

/**
 * MCP Request Handler
 * Processes JSON-RPC 2.0 requests and routes to appropriate handlers
 */
export class MCPRequestHandler {
  private authContext: MCPAuthContext | null = null;

  /**
   * Handle JSON-RPC request
   */
  async handle(
    request: JsonRpcRequest,
    authContext?: MCPAuthContext
  ): Promise<JsonRpcResponse> {
    // Store auth context if provided
    if (authContext) {
      this.authContext = authContext;
    }

    // Route to appropriate handler based on method
    switch (request.method) {
      case MCPMethod.INITIALIZE:
        return await this.handleInitialize(request);
      case MCPMethod.PING:
        return await this.handlePing(request);
      case MCPMethod.TOOLS_LIST:
        return await this.handleToolsList(request);
      case MCPMethod.TOOLS_CALL:
        return await this.handleToolsCall(request);
      default:
        return this.createErrorResponse(
          request.id,
          -32601,
          `Method not found: ${request.method}`
        );
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(
    request: JsonRpcRequest
  ): Promise<JsonRpcResponse> {
    const params = request.params as InitializeParams | undefined;

    if (!params) {
      return this.createErrorResponse(
        request.id,
        -32602,
        'Invalid params: initialize requires protocolVersion, capabilities, and clientInfo'
      );
    }

    // Validate protocol version
    if (!params.protocolVersion) {
      return this.createErrorResponse(
        request.id,
        -32602,
        'Invalid params: protocolVersion is required'
      );
    }

    // Get initialize result
    const result = getInitializeResult(params.protocolVersion);

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: result as unknown as JsonRpcResult,
    };
  }

  /**
   * Handle ping request
   */
  private async handlePing(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {} as JsonValue,
    };
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(
    request: JsonRpcRequest
  ): Promise<JsonRpcResponse> {
    const tools = getAvailableTools();
    const result: ToolsListResult = {
      tools,
    };

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: result as unknown as JsonRpcResult,
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(
    request: JsonRpcRequest
  ): Promise<JsonRpcResponse> {
    // Require authentication for tool calls
    if (!this.authContext) {
      return this.createErrorResponse(
        request.id,
        -32000,
        'Authentication required'
      );
    }

    const params = request.params as ToolCallParams | undefined;

    if (!params || !params.name) {
      return this.createErrorResponse(
        request.id,
        -32602,
        'Invalid params: tools/call requires name and arguments'
      );
    }

    // Authenticate agent using API key
    const agent = await authenticateAgent({
      apiKey: this.authContext.apiKey,
    });

    if (!agent) {
      return this.createErrorResponse(
        request.id,
        -32001,
        'Authentication failed'
      );
    }

    // Execute tool with proper error handling per MCP spec
    // Tool execution errors should return isError: true, not protocol errors
    try {
      const toolResult = await executeTool(
        params.name,
        params.arguments as StringRecord<JsonValue>,
        agent
      );

      // Convert tool result to MCP content format
      const content = this.convertToolResultToContent(
        toolResult as unknown as JsonValue
      );

      const result: ToolCallResult = {
        content,
        isError: false,
      };

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: result as unknown as JsonRpcResult,
      };
    } catch (error) {
      // Per MCP spec: Tool execution errors should be reported in tool results
      // with isError: true, not as JSON-RPC protocol errors
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';

      const result: ToolCallResult = {
        content: [
          {
            type: 'text',
            text: `Tool execution failed: ${errorMessage}`,
          },
        ],
        isError: true,
      };

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: result as unknown as JsonRpcResult,
      };
    }
  }

  /**
   * Convert tool result to MCP content format
   * Formats results as readable text content
   */
  private convertToolResultToContent(
    toolResult: JsonValue
  ): Array<{ type: 'text'; text: string }> {
    // Handle different result types
    if (typeof toolResult === 'string') {
      return [
        {
          type: 'text' as const,
          text: toolResult,
        },
      ];
    }

    if (typeof toolResult === 'object' && toolResult !== null) {
      // Format object results as readable JSON
      const formatted = JSON.stringify(toolResult, null, 2);
      return [
        {
          type: 'text' as const,
          text: formatted,
        },
      ];
    }

    // Fallback: convert to string
    return [
      {
        type: 'text' as const,
        text: String(toolResult),
      },
    ];
  }

  /**
   * Create JSON-RPC error response
   */
  private createErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: JsonValue
  ): JsonRpcResponse {
    const error: JsonRpcError = {
      code,
      message,
      data,
    };

    return {
      jsonrpc: '2.0',
      id,
      error,
    };
  }
}
