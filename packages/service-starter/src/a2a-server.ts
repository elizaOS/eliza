/**
 * A2A Server Implementation
 * 
 * Agent-to-Agent protocol server that enables discovery and interaction
 * between autonomous agents. Includes x402 payment integration.
 * 
 * Implements A2A Protocol v0.3.0
 * @see https://a2a-protocol.org/specification
 */

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getX402Status, type PaymentRequirements, type X402Network } from './x402';
import type { ServiceConfig } from './config';

// ============================================================================
// Types - A2A Protocol v0.3.0
// ============================================================================

export interface A2AConfig extends ServiceConfig {}

/** A2A Message Part - content within a message */
interface MessagePart {
  kind: 'text' | 'data' | 'file' | 'filePart';
  text?: string;
  data?: Record<string, unknown>;
  file?: {
    name: string;
    mimeType: string;
    bytes?: string; // base64
    uri?: string;
  };
}

/** A2A Message - the core communication unit */
interface A2AMessage {
  messageId: string;
  role?: 'user' | 'agent';
  parts: MessagePart[];
  contextId?: string; // For conversation tracking
  taskId?: string;    // If this message is part of a task
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

/** A2A JSON-RPC Request */
interface A2ARequest {
  jsonrpc: '2.0';
  method: string;
  params?: {
    message?: A2AMessage;
    id?: string; // Task ID for task operations
    metadata?: Record<string, unknown>;
  };
  id: number | string | null;
}

/** A2A Task State */
type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/** A2A Task */
interface A2ATask {
  id: string;
  contextId?: string;
  state: TaskState;
  message?: A2AMessage;
  artifacts?: Array<{ name: string; parts: MessagePart[] }>;
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

interface SkillResult {
  message: string;
  data: Record<string, unknown>;
  requiresPayment?: PaymentRequirements;
}

interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputSchema?: {
    type: string;
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  examples?: string[];
  requiresPayment?: boolean;
}

/** Task storage interface - implement for production persistence */
export interface TaskStore {
  get(id: string): A2ATask | undefined;
  set(id: string, task: A2ATask): void;
  delete(id: string): boolean;
  size(): number;
}

/** In-memory task store - suitable for development/single instance */
class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, A2ATask>();
  private maxTasks = 1000; // Prevent unbounded growth
  
  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }
  
  set(id: string, task: A2ATask): void {
    // Evict oldest completed tasks if at capacity
    if (this.tasks.size >= this.maxTasks) {
      for (const [taskId, t] of this.tasks) {
        if (t.state === 'completed' || t.state === 'failed' || t.state === 'canceled') {
          this.tasks.delete(taskId);
          break;
        }
      }
    }
    this.tasks.set(id, task);
  }
  
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }
  
  size(): number {
    return this.tasks.size;
  }
}

// ============================================================================
// Define Your Skills
// ============================================================================

function getSkills(_config: A2AConfig): A2ASkill[] {
  return [
    { id: 'get-info', name: 'Get Service Info', description: 'Service capabilities', tags: ['query', 'info'], examples: ['What can you do?'] },
    { id: 'echo', name: 'Echo Message', description: 'Echo a message', tags: ['query', 'test'], inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, examples: ['Echo hello'] },
    { id: 'get-status', name: 'Get Service Status', description: 'Health status', tags: ['query', 'health'], examples: ['Service status'] },
  ];
}

// ============================================================================
// Skill Handlers
// ============================================================================

function getX402ConfigFromService(config: A2AConfig) {
  return {
    enabled: config.x402Enabled,
    recipientAddress: (config.paymentRecipient || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    network: (config.x402Network || 'base-sepolia') as X402Network,
    serviceName: config.serviceName,
  };
}

async function executeSkill(
  skillId: string, 
  params: Record<string, unknown>, 
  config: A2AConfig,
  _userAddress?: string,
  _paymentHeader?: string
): Promise<SkillResult> {
  const x402Status = getX402Status(getX402ConfigFromService(config));

  switch (skillId) {
    case 'get-info':
      return {
        message: `I am ${config.serviceName}. ${config.serviceDescription}`,
        data: {
          name: config.serviceName,
          version: config.version,
          x402: { enabled: x402Status.enabled, mode: x402Status.mode, facilitator: x402Status.facilitator },
          erc8004: config.erc8004Enabled,
          skills: getSkills(config).map(s => s.id),
        },
      };
    case 'echo':
      return { message: `Echo: ${params.message}`, data: { echo: params.message, timestamp: new Date().toISOString() } };
    case 'get-status':
      return { message: 'Service healthy', data: { status: 'healthy', uptime: process.uptime(), network: config.network, x402: x402Status.mode } };
    default:
      return { message: `Unknown skill: ${skillId}`, data: { error: 'Skill not found', available: getSkills(config).map(s => s.id) } };
  }
}

// ============================================================================
// A2A Server Class
// ============================================================================

export class A2AServer {
  private app: Hono;
  private config: A2AConfig;
  private taskStore: TaskStore;

  constructor(config: A2AConfig, taskStore?: TaskStore) {
    this.config = config;
    this.taskStore = taskStore || new InMemoryTaskStore();
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use('/*', cors());

    // Agent card for discovery (standard location)
    this.app.get('/.well-known/agent-card.json', (c) => c.json(this.getAgentCard()));

    // Skills listing endpoint (REST convenience)
    this.app.get('/skills', (c) => c.json({
      skills: getSkills(this.config).map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        inputSchema: skill.inputSchema,
        examples: skill.examples,
        requiresPayment: skill.requiresPayment || false,
      })),
    }));

    // Main A2A JSON-RPC endpoint
    this.app.post('/', async (c) => {
      const body = await c.req.json<A2ARequest>().catch(() => null);
      
      // JSON-RPC parse error - return 200 with error per spec
      if (!body) {
        return c.json({ 
          jsonrpc: '2.0', 
          id: null, 
          error: { code: -32700, message: 'Parse error: invalid JSON' } 
        });
      }

      // Validate JSON-RPC version
      if (body.jsonrpc !== '2.0') {
        return c.json({ 
          jsonrpc: '2.0', 
          id: body.id ?? null, 
          error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } 
        });
      }

      // Handle different A2A methods
      switch (body.method) {
        case 'message/send':
          return this.handleMessageSend(c, body);
        
        case 'tasks/send':
          return this.handleTaskSend(c, body);
        
        case 'tasks/get':
          return this.handleTaskGet(c, body);
        
        case 'tasks/cancel':
          return this.handleTaskCancel(c, body);
        
        case 'agent/describe':
          return c.json({
            jsonrpc: '2.0',
            id: body.id,
            result: this.getAgentCard(),
          });
        
        case 'skills/list':
          return c.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              skills: getSkills(this.config).map(s => ({
                id: s.id,
                name: s.name,
                description: s.description,
                tags: s.tags,
                inputSchema: s.inputSchema,
              })),
            },
          });
        
        default:
          return c.json({ 
            jsonrpc: '2.0', 
            id: body.id, 
            error: { code: -32601, message: `Method not found: ${body.method}` } 
          });
      }
    });

    // Health
    this.app.get('/health', (c) => c.json({ 
      status: 'ok', 
      service: 'a2a',
      protocolVersion: '0.3.0',
      skills: getSkills(this.config).length,
      activeTasks: this.taskStore.size(),
    }));
  }

  /**
   * Handle message/send - synchronous message processing
   */
  private async handleMessageSend(c: Context, body: A2ARequest): Promise<Response> {
    const message = body.params?.message;
    if (!message?.parts) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: 'Invalid params: message.parts required' } 
      });
    }

    // Extract skill ID and params from message
    const { skillId, params, error } = this.extractSkillFromMessage(message);
    
    if (error) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: error } 
      });
    }

    // Validate skill exists
    const availableSkills = getSkills(this.config);
    const skill = availableSkills.find(s => s.id === skillId);
    if (!skill) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { 
          code: -32602, 
          message: `Unknown skill: ${skillId}`,
          data: { availableSkills: availableSkills.map(s => s.id) }
        } 
      });
    }

    const userAddress = c.req.header('x-jeju-address');
    const paymentHeader = c.req.header('x-payment');

    const result = await executeSkill(
      skillId, 
      params, 
      this.config,
      userAddress, 
      paymentHeader
    );

    // Return 402 if payment required
    if (result.requiresPayment) {
      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { 
          code: 402, 
          message: 'Payment Required', 
          data: result.requiresPayment 
        },
      }, 402);
    }

    // Generate response message ID
    const responseMessageId = `${message.messageId}-response`;

    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        messageId: responseMessageId,
        role: 'agent',
        parts: [
          { kind: 'text', text: result.message },
          { kind: 'data', data: result.data },
        ],
        contextId: message.contextId, // Echo back contextId for conversation tracking
        metadata: {
          skillId,
          timestamp: new Date().toISOString(),
        },
      },
    });
  }

  /**
   * Handle tasks/send - async task processing
   */
  private async handleTaskSend(c: Context, body: A2ARequest): Promise<Response> {
    const message = body.params?.message;
    if (!message?.parts) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: 'Invalid params: message.parts required' } 
      });
    }

    const { skillId, params, error } = this.extractSkillFromMessage(message);
    
    if (error) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: error } 
      });
    }

    // Create task
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const task: A2ATask = {
      id: taskId,
      contextId: message.contextId,
      state: 'submitted',
      message,
      history: [message],
      metadata: body.params?.metadata,
    };

    this.taskStore.set(taskId, task);

    // Execute skill asynchronously
    this.executeTaskAsync(taskId, skillId, params, c.req.header('x-jeju-address'), c.req.header('x-payment'));

    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        id: taskId,
        contextId: message.contextId,
        state: 'submitted',
        message: {
          messageId: `${taskId}-ack`,
          role: 'agent',
          parts: [{ kind: 'text', text: `Task ${taskId} submitted. Processing skill: ${skillId}` }],
        },
      },
    });
  }

  /**
   * Handle tasks/get - get task status
   */
  private handleTaskGet(c: Context, body: A2ARequest): Response {
    const taskId = body.params?.id;
    if (!taskId) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: 'Invalid params: id required' } 
      });
    }

    const task = this.taskStore.get(taskId);
    if (!task) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: `Task not found: ${taskId}` } 
      });
    }

    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      result: task,
    });
  }

  /**
   * Handle tasks/cancel - cancel a task
   */
  private handleTaskCancel(c: Context, body: A2ARequest): Response {
    const taskId = body.params?.id;
    if (!taskId) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: 'Invalid params: id required' } 
      });
    }

    const task = this.taskStore.get(taskId);
    if (!task) {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: `Task not found: ${taskId}` } 
      });
    }

    // Can only cancel tasks that haven't completed
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'canceled') {
      return c.json({ 
        jsonrpc: '2.0', 
        id: body.id, 
        error: { code: -32602, message: `Cannot cancel task in state: ${task.state}` } 
      });
    }

    task.state = 'canceled';
    
    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      result: task,
    });
  }

  /**
   * Execute task asynchronously and update state
   */
  private async executeTaskAsync(
    taskId: string, 
    skillId: string, 
    params: Record<string, unknown>,
    userAddress?: string,
    paymentHeader?: string
  ): Promise<void> {
    const task = this.taskStore.get(taskId);
    if (!task) return;

    task.state = 'working';

    const result = await executeSkill(skillId, params, this.config, userAddress, paymentHeader);

    if (result.requiresPayment) {
      task.state = 'input-required';
      task.message = {
        messageId: `${taskId}-payment`,
        role: 'agent',
        parts: [
          { kind: 'text', text: 'Payment required to continue' },
          { kind: 'data', data: result.requiresPayment as unknown as Record<string, unknown> },
        ],
      };
    } else {
      task.state = 'completed';
      task.message = {
        messageId: `${taskId}-result`,
        role: 'agent',
        parts: [
          { kind: 'text', text: result.message },
          { kind: 'data', data: result.data },
        ],
      };
      task.artifacts = [{
        name: 'result',
        parts: [{ kind: 'data', data: result.data }],
      }];
    }
  }

  /**
   * Extract skill ID and params from A2A message
   */
  private extractSkillFromMessage(message: A2AMessage): { 
    skillId: string; 
    params: Record<string, unknown>; 
    error?: string;
  } {
    const dataPart = message.parts.find((p) => p.kind === 'data');
    const textPart = message.parts.find((p) => p.kind === 'text');
    
    let skillId: string;
    let params: Record<string, unknown> = {};
    
    if (dataPart?.data) {
      // Structured data request - extract skillId
      skillId = (dataPart.data.skillId as string) || '';
      params = (dataPart.data.params as Record<string, unknown>) || {};
      
      // If no skillId but has other data, pass it as params
      if (!skillId && Object.keys(dataPart.data).length > 0) {
        params = dataPart.data;
        skillId = 'get-info'; // Default skill for unspecified requests
      }
    } else if (textPart?.text) {
      // Natural language request - detect intent
      skillId = this.detectSkillFromText(textPart.text);
      params = { message: textPart.text };
    } else {
      return { 
        skillId: '', 
        params: {}, 
        error: 'No skill or message provided in parts' 
      };
    }

    return { skillId, params };
  }

  private detectSkillFromText(text: string): string {
    const lower = text.toLowerCase();
    const keywords: Record<string, string[]> = {
      'get-info': ['info', 'help', 'what can you do', 'capabilities', 'about'],
      'get-status': ['status', 'health', 'healthy', 'alive', 'running'],
      'echo': ['echo', 'repeat'],
    };
    for (const [skill, words] of Object.entries(keywords)) {
      if (words.some(w => lower.includes(w))) return skill;
    }
    return 'get-info';
  }

  getAgentCard(): Record<string, unknown> {
    const skills = getSkills(this.config);
    const x402Status = getX402Status(getX402ConfigFromService(this.config));
    const authSchemes = x402Status.enabled && x402Status.configured ? ['x402', 'bearer'] : ['bearer'];
    
    return {
      protocolVersion: '0.3.0',
      name: this.config.serviceName,
      description: this.config.serviceDescription,
      url: '/a2a',
      preferredTransport: 'http',
      provider: { organization: 'elizaOS', url: 'https://elizaos.ai' },
      version: this.config.version,
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true, tasks: true },
      defaultInputModes: ['text', 'data'],
      defaultOutputModes: ['text', 'data'],
      authentication: {
        schemes: authSchemes,
        ...(x402Status.enabled && x402Status.configured && {
          x402: { mode: x402Status.mode, facilitator: x402Status.facilitator, network: x402Status.network, ...(x402Status.recipient && { payTo: x402Status.recipient }) },
        }),
      },
      skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, inputSchema: s.inputSchema, examples: s.examples, ...(s.requiresPayment && { requiresPayment: true }) })),
      supportedMethods: ['message/send', 'tasks/send', 'tasks/get', 'tasks/cancel', 'agent/describe', 'skills/list'],
    };
  }

  getRouter(): Hono {
    return this.app;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createA2AServer(config: A2AConfig): A2AServer {
  return new A2AServer(config);
}
