/**
 * MCP Server Implementation
 * 
 * Model Context Protocol server that exposes service capabilities to AI assistants.
 * Implements MCP Protocol 2024-11-05.
 * Includes x402 payment integration for paid operations.
 * 
 * @see https://modelcontextprotocol.io/specification
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getX402Status, type PaymentRequirements, type X402Network } from './x402';
import type { ServiceConfig } from './config';

// ============================================================================
// MCP Protocol Types (2024-11-05)
// ============================================================================

export interface MCPConfig extends ServiceConfig {}

/** MCP Protocol Version */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/** MCP Error Codes (per JSON-RPC 2.0 + MCP extensions) */
const MCPErrorCodes = {
  // JSON-RPC standard errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCP-specific errors
  RESOURCE_NOT_FOUND: -32002,
  TOOL_NOT_FOUND: -32003,
  PROMPT_NOT_FOUND: -32004,
  // x402 payment error
  PAYMENT_REQUIRED: 402,
} as const;

/** MCP Log Levels */
type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

/** MCP Server Capabilities */
interface ServerCapabilities {
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  logging?: Record<string, never>;
  experimental?: Record<string, unknown>;
}

/** MCP Server Info */
interface ServerInfo {
  name: string;
  version: string;
}

/** MCP Initialize Result */
interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}

/** MCP Tool Result */
interface MCPToolResult {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string; uri?: string }>;
  isError?: boolean;
  requiresPayment?: PaymentRequirements;
}

/** MCP Resource */
interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP Resource Contents */
interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // base64
}

/** MCP Tool Definition */
interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      default?: unknown;
    }>;
    required?: string[];
  };
  // Extension: x402 payment support
  requiresPayment?: boolean;
}

/** MCP Prompt Definition */
interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** MCP Completion Reference */
interface CompletionRef {
  type: 'ref/resource' | 'ref/prompt';
  uri?: string;
  name?: string;
}

/** MCP Completion Request */
interface CompletionRequest {
  ref: CompletionRef;
  argument: {
    name: string;
    value: string;
  };
}

// ============================================================================
// MCP Server Info & Capabilities
// ============================================================================

function getServerInfo(config: MCPConfig): ServerInfo {
  return {
    name: config.serviceName.toLowerCase().replace(/\s+/g, '-'),
    version: config.version,
  };
}

function getX402ConfigFromService(config: MCPConfig) {
  return {
    enabled: config.x402Enabled,
    recipientAddress: (config.paymentRecipient || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    network: (config.x402Network || 'base-sepolia') as X402Network,
    serviceName: config.serviceName,
  };
}

function getServerCapabilities(config: MCPConfig): ServerCapabilities {
  const x402Status = getX402Status(getX402ConfigFromService(config));
  return {
    resources: { subscribe: false, listChanged: false },
    tools: { listChanged: false },
    prompts: { listChanged: false },
    logging: {},
    experimental: {
      x402Payments: x402Status.enabled && x402Status.configured,
      x402Mode: x402Status.mode,
      x402Facilitator: x402Status.facilitator,
      erc8004Integration: config.erc8004Enabled,
    },
  };
}

// ============================================================================
// Resources, Tools, Prompts
// ============================================================================

function getResources(_config: MCPConfig): MCPResource[] {
  return [
    { uri: 'service://info', name: 'Service Information', description: 'Service info', mimeType: 'application/json' },
    { uri: 'service://status', name: 'Service Status', description: 'Health metrics', mimeType: 'application/json' },
  ];
}

function getTools(_config: MCPConfig): MCPTool[] {
  return [
    { name: 'get_info', description: 'Get service capabilities', inputSchema: { type: 'object', properties: {} } },
    { name: 'echo', description: 'Echo a message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
    { name: 'get_status', description: 'Get service status', inputSchema: { type: 'object', properties: {} } },
  ];
}

function getPrompts(_config: MCPConfig): MCPPrompt[] {
  return [];
}

// ============================================================================
// Handlers
// ============================================================================

async function readResource(uri: string, config: MCPConfig): Promise<unknown | null> {
  switch (uri) {
    case 'service://info':
      return { name: config.serviceName, description: config.serviceDescription, version: config.version, x402: config.x402Enabled, erc8004: config.erc8004Enabled };
    case 'service://status':
      return { status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString(), network: config.network };
    default:
      return null;
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  config: MCPConfig,
  _userAddress?: string,
  _paymentHeader?: string
): Promise<MCPToolResult> {
  const result = (data: unknown, isError = false): MCPToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  });

  const x402Status = getX402Status(getX402ConfigFromService(config));

  switch (name) {
    case 'get_info':
      return result({
        name: config.serviceName,
        description: config.serviceDescription,
        version: config.version,
        x402: { enabled: x402Status.enabled, mode: x402Status.mode, facilitator: x402Status.facilitator },
        erc8004: config.erc8004Enabled,
        tools: getTools(config).map(t => t.name),
        resources: getResources(config).map(r => r.uri),
      });
    case 'echo':
      return result({ echo: args.message, timestamp: new Date().toISOString() });
    case 'get_status':
      return result({ status: 'healthy', uptime: process.uptime(), network: config.network, x402: x402Status.mode });
    default:
      return result({ error: `Tool not found: ${name}` }, true);
  }
}

// ============================================================================
// MCP Server Class
// ============================================================================

export class MCPServer {
  private app: Hono;
  private config: MCPConfig;
  private logLevel: LogLevel = 'info';
  private initialized = false;

  constructor(config: MCPConfig) {
    this.config = config;
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use('/*', cors());

    // Content-Type validation middleware for POST requests
    this.app.use('/*', async (c, next) => {
      if (c.req.method === 'POST') {
        const contentType = c.req.header('content-type');
        if (!contentType?.includes('application/json')) {
          return c.json({
            error: {
              code: MCPErrorCodes.INVALID_REQUEST,
              message: 'Content-Type must be application/json',
            },
          }, 400);
        }
      }
      await next();
    });

    // ========================================
    // Lifecycle Methods
    // ========================================

    // MCP Initialize - required first call
    this.app.post('/initialize', async (c) => {
      const body = await c.req.json<{ 
        protocolVersion?: string; 
        capabilities?: Record<string, unknown>;
        clientInfo?: { name: string; version: string };
      }>().catch(() => ({}));
      
      this.initialized = true;
      
      const result: InitializeResult = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: getServerCapabilities(this.config),
        serverInfo: getServerInfo(this.config),
      };
      
      // Log initialization
      this.log('info', `MCP initialized by client: ${body.clientInfo?.name || 'unknown'}`);
      
      return c.json(result);
    });

    // Ping - keep-alive / health check
    this.app.post('/ping', (c) => c.json({}));

    // ========================================
    // Resource Methods
    // ========================================

    // List resources
    this.app.post('/resources/list', async (c) => {
      const { cursor } = await c.req.json<{ cursor?: string }>().catch(() => ({}));
      
      const resources = getResources(this.config);
      
      // Simple pagination - return all for now
      return c.json({ 
        resources,
        nextCursor: cursor ? undefined : undefined, // No pagination for small lists
      });
    });

    // Read resource
    this.app.post('/resources/read', async (c) => {
      const body = await c.req.json<{ uri?: string }>().catch(() => ({}));
      const { uri } = body;
      
      if (!uri) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: 'Missing required parameter: uri' 
          } 
        }, 400);
      }
      
      const data = await readResource(uri, this.config);
      
      if (data === null) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.RESOURCE_NOT_FOUND, 
            message: `Resource not found: ${uri}` 
          } 
        }, 404);
      }

      const contents: ResourceContents[] = [{ 
        uri, 
        mimeType: 'application/json', 
        text: JSON.stringify(data, null, 2),
      }];

      return c.json({ contents });
    });

    // Subscribe to resource (placeholder - not fully implemented)
    this.app.post('/resources/subscribe', async (c) => {
      const { uri } = await c.req.json<{ uri?: string }>().catch(() => ({}));
      
      if (!uri) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: 'Missing required parameter: uri' 
          } 
        }, 400);
      }
      
      // Acknowledge subscription (no-op for now)
      this.log('debug', `Resource subscription requested: ${uri}`);
      return c.json({});
    });

    // Unsubscribe from resource
    this.app.post('/resources/unsubscribe', async (c) => {
      const { uri } = await c.req.json<{ uri?: string }>().catch(() => ({}));
      
      if (!uri) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: 'Missing required parameter: uri' 
          } 
        }, 400);
      }
      
      return c.json({});
    });

    // ========================================
    // Tool Methods
    // ========================================

    // List tools
    this.app.post('/tools/list', async (c) => {
      const { cursor } = await c.req.json<{ cursor?: string }>().catch(() => ({}));
      
      const tools = getTools(this.config);
      
      return c.json({ 
        tools,
        nextCursor: cursor ? undefined : undefined,
      });
    });

    // Call tool
    this.app.post('/tools/call', async (c) => {
      const body = await c.req.json<{ 
        name?: string; 
        arguments?: Record<string, unknown> 
      }>().catch(() => ({}));
      
      const { name, arguments: args } = body;
      
      if (!name) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: 'Missing required parameter: name' 
          } 
        }, 400);
      }
      
      // Check if tool exists
      const tools = getTools(this.config);
      const tool = tools.find(t => t.name === name);
      
      if (!tool) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.TOOL_NOT_FOUND, 
            message: `Tool not found: ${name}` 
          } 
        }, 404);
      }
      
      const userAddress = c.req.header('x-jeju-address');
      const paymentHeader = c.req.header('x-payment');

      this.log('debug', `Tool call: ${name}`);
      
      const result = await callTool(
        name, 
        args || {}, 
        this.config,
        userAddress, 
        paymentHeader
      );

      // Return 402 if payment required
      if (result.requiresPayment) {
        return c.json({
          error: {
            code: MCPErrorCodes.PAYMENT_REQUIRED,
            message: 'Payment Required',
            data: result.requiresPayment,
          },
        }, 402);
      }

      return c.json(result);
    });

    // ========================================
    // Prompt Methods
    // ========================================

    // List prompts
    this.app.post('/prompts/list', async (c) => {
      const { cursor } = await c.req.json<{ cursor?: string }>().catch(() => ({}));
      
      const prompts = getPrompts(this.config);
      
      return c.json({ 
        prompts,
        nextCursor: cursor ? undefined : undefined,
      });
    });

    // Get prompt
    this.app.post('/prompts/get', async (c) => {
      const { name, arguments: args } = await c.req.json<{ 
        name?: string;
        arguments?: Record<string, string>;
      }>().catch(() => ({}));
      
      if (!name) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: 'Missing required parameter: name' 
          } 
        }, 400);
      }
      
      const prompts = getPrompts(this.config);
      const prompt = prompts.find(p => p.name === name);
      
      if (!prompt) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.PROMPT_NOT_FOUND, 
            message: `Prompt not found: ${name}` 
          } 
        }, 404);
      }
      
      // Return prompt messages (placeholder - customize based on your prompts)
      return c.json({
        description: prompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt: ${name} with args: ${JSON.stringify(args || {})}`,
            },
          },
        ],
      });
    });

    // ========================================
    // Logging Methods
    // ========================================

    // Set logging level
    this.app.post('/logging/setLevel', async (c) => {
      const { level } = await c.req.json<{ level?: LogLevel }>().catch(() => ({}));
      
      const validLevels: LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
      
      if (!level || !validLevels.includes(level)) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: `Invalid log level. Must be one of: ${validLevels.join(', ')}` 
          } 
        }, 400);
      }
      
      this.logLevel = level;
      this.log('info', `Log level set to: ${level}`);
      
      return c.json({});
    });

    // ========================================
    // Completion Methods
    // ========================================

    // Argument completion
    this.app.post('/completion/complete', async (c) => {
      const body = await c.req.json<CompletionRequest>().catch(() => ({} as CompletionRequest));
      
      if (!body.ref || !body.argument) {
        return c.json({ 
          error: { 
            code: MCPErrorCodes.INVALID_PARAMS, 
            message: 'Missing required parameters: ref, argument' 
          } 
        }, 400);
      }
      
      // Provide completions based on reference type
      const completions: Array<{ values: string[]; total?: number; hasMore?: boolean }> = [];
      
      if (body.ref.type === 'ref/resource') {
        // Suggest resource URIs
        const resources = getResources(this.config);
        const matching = resources
          .map(r => r.uri)
          .filter(uri => uri.includes(body.argument.value));
        completions.push({ values: matching, total: matching.length, hasMore: false });
      } else if (body.ref.type === 'ref/prompt') {
        // Suggest prompt argument values (placeholder)
        completions.push({ values: [], total: 0, hasMore: false });
      }
      
      return c.json({
        completion: completions[0] || { values: [], total: 0, hasMore: false },
      });
    });

    // ========================================
    // Discovery / Health Endpoints (REST)
    // ========================================

    // Discovery endpoint (GET for convenience)
    this.app.get('/', (c) => c.json({
      protocol: 'mcp',
      protocolVersion: MCP_PROTOCOL_VERSION,
      server: getServerInfo(this.config).name,
      version: this.config.version,
      description: this.config.serviceDescription,
      capabilities: getServerCapabilities(this.config),
      resources: getResources(this.config).length,
      tools: getTools(this.config).length,
      prompts: getPrompts(this.config).length,
      authentication: {
        schemes: this.config.x402Enabled ? ['x402'] : [],
        headers: ['x-payment', 'x-jeju-address'],
      },
      endpoints: {
        initialize: 'POST /initialize',
        resources: 'POST /resources/list, /resources/read',
        tools: 'POST /tools/list, /tools/call',
        prompts: 'POST /prompts/list, /prompts/get',
        logging: 'POST /logging/setLevel',
        completion: 'POST /completion/complete',
      },
    }));

    // Health
    this.app.get('/health', (c) => c.json({ 
      status: 'ok',
      protocol: 'mcp',
      protocolVersion: MCP_PROTOCOL_VERSION,
      server: getServerInfo(this.config).name,
      version: this.config.version,
      initialized: this.initialized,
    }));
  }

  /**
   * Internal logging helper
   */
  private log(level: LogLevel, message: string): void {
    const levels: LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
    const currentLevel = levels.indexOf(this.logLevel);
    const messageLevel = levels.indexOf(level);
    
    if (messageLevel >= currentLevel) {
      console.log(`[MCP:${level}] ${message}`);
    }
  }

  getRouter(): Hono {
    return this.app;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMCPServer(config: MCPConfig): MCPServer {
  return new MCPServer(config);
}
