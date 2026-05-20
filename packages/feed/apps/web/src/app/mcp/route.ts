/**
 * MCP (Model Context Protocol) Server Endpoint
 *
 * Implements MCP protocol using JSON-RPC 2.0 over HTTP.
 * Supports methods: initialize, tools/list, tools/call
 *
 * @openapi
 * /mcp:
 *   post:
 *     tags:
 *       - MCP Protocol
 *     summary: MCP JSON-RPC endpoint
 *     description: Handles Model Context Protocol JSON-RPC 2.0 requests over HTTP for agent tool discovery and execution.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jsonrpc
 *               - method
 *               - id
 *             properties:
 *               jsonrpc:
 *                 type: string
 *                 enum: ["2.0"]
 *               method:
 *                 type: string
 *                 description: MCP method name (e.g., initialize, tools/list, tools/call)
 *               params:
 *                 type: object
 *               id:
 *                 type: string | number
 *     responses:
 *       200:
 *         description: JSON-RPC response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jsonrpc:
 *                   type: string
 *                 result:
 *                   type: object
 *                 error:
 *                   type: object
 *                 id:
 *                   type: string | number
 *   get:
 *     tags:
 *       - MCP Protocol
 *     summary: MCP server info
 *     description: Returns MCP server information and available tools (for discovery).
 *     responses:
 *       200:
 *         description: Server info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 version:
 *                   type: string
 *                 tools:
 *                   type: array
 */

import type { JsonRpcRequest, MCPAuthContext } from '@babylon/mcp';
import {
  getAvailableTools,
  getMCPServerInfo,
  MCPRequestHandler,
} from '@babylon/mcp';
import type { JsonValue } from '@babylon/shared';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Initialize MCP request handler
const mcpHandler = new MCPRequestHandler();

/**
 * Extract authentication from request headers
 */
function extractAuthFromHeaders(request: NextRequest): MCPAuthContext {
  // Check for X-Babylon-Api-Key header (primary method)
  const apiKey = request.headers.get('x-babylon-api-key');

  // Also check Authorization header with Bearer token for compatibility
  const authHeader = request.headers.get('authorization');
  const apiKeyFromAuth = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;

  const auth: MCPAuthContext = {};

  // Prefer X-Babylon-Api-Key header, fallback to Authorization Bearer
  if (apiKey) {
    auth.apiKey = apiKey;
  } else if (apiKeyFromAuth) {
    auth.apiKey = apiKeyFromAuth;
  }

  return auth;
}

/**
 * GET /mcp - Get MCP server info and available tools
 * Used for discovery and validation (e.g., by Agent0)
 */
export async function GET(request: NextRequest) {
  logger.debug('MCP endpoint accessed', { url: request.url }, 'MCP');

  const serverInfo = getMCPServerInfo();
  const tools = getAvailableTools();

  return NextResponse.json(
    {
      ...serverInfo,
      tools,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    }
  );
}

/**
 * POST /mcp - Handle MCP JSON-RPC 2.0 requests
 * Supports: initialize, tools/list, tools/call
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as JsonValue;

  // Validate JSON-RPC 2.0 request format
  if (
    typeof body !== 'object' ||
    body === null ||
    !('jsonrpc' in body) ||
    !('method' in body) ||
    !('id' in body)
  ) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      },
      { status: 400 }
    );
  }

  // Validate and type the request
  if (
    typeof body !== 'object' ||
    body === null ||
    !('jsonrpc' in body) ||
    !('method' in body) ||
    !('id' in body)
  ) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      },
      { status: 400 }
    );
  }

  const jsonRpcRequest = body as unknown as JsonRpcRequest;

  if (jsonRpcRequest.jsonrpc !== '2.0') {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: jsonRpcRequest.id,
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"',
        },
      },
      { status: 400 }
    );
  }

  // Extract authentication from headers
  const authContext = extractAuthFromHeaders(request);

  // Require API key for POST requests (except GET which is for discovery)
  if (!authContext.apiKey) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: jsonRpcRequest.id,
        error: {
          code: -32001,
          message:
            'Authentication required: X-Babylon-Api-Key header is required',
        },
      },
      { status: 401 }
    );
  }

  // Handle request
  const response = await mcpHandler.handle(jsonRpcRequest, authContext);

  return NextResponse.json(response, {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
