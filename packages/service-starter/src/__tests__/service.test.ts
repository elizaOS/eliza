/**
 * Service Starter Tests
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { createMCPServer } from '../mcp-server';
import { createA2AServer } from '../a2a-server';
import type { ServiceConfig } from '../config';

const testConfig: ServiceConfig = {
  serviceName: 'Test Service',
  serviceDescription: 'A test service for unit testing',
  version: '1.0.0',
  port: 3001,
  network: 'testnet',
  rpcUrl: 'https://sepolia.base.org',
  privateKey: '',
  x402Enabled: true,
  erc8004Enabled: false,
  autoRegister: false,
  isPublic: true,
  category: 'test',
  paymentRecipient: '',
  x402Network: 'base-sepolia',
  x402Facilitator: 'https://pay-testnet.elizaos.ai/v1/base-sepolia',
  tags: ['test'],
};

describe('MCP Server', () => {
  let mcpServer: ReturnType<typeof createMCPServer>;
  let app: Hono;

  beforeAll(() => {
    mcpServer = createMCPServer(testConfig);
    app = mcpServer.getRouter();
  });

  it('should return server info on GET /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.server).toBe('test-service');
    expect(data.version).toBe('1.0.0');
  });

  it('should return health status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('should initialize MCP protocol', async () => {
    const res = await app.request('/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-client', version: '1.0.0' },
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.protocolVersion).toBe('2024-11-05');
    expect(data.serverInfo.name).toBe('test-service');
    expect(data.capabilities.tools).toBeDefined();
    expect(data.capabilities.resources).toBeDefined();
    expect(data.capabilities.logging).toBeDefined();
  });

  it('should handle ping', async () => {
    const res = await app.request('/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it('should list tools', async () => {
    const res = await app.request('/tools/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBeGreaterThan(0);
    
    const echoTool = data.tools.find((t: { name: string }) => t.name === 'echo');
    expect(echoTool).toBeDefined();
  });

  it('should call echo tool', async () => {
    const res = await app.request('/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'echo',
        arguments: { message: 'Hello, World!' },
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.content).toBeDefined();
    expect(data.content[0].type).toBe('text');
    
    const content = JSON.parse(data.content[0].text);
    expect(content.echo).toBe('Hello, World!');
  });

  it('should list resources', async () => {
    const res = await app.request('/resources/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(Array.isArray(data.resources)).toBe(true);
    expect(data.resources.length).toBeGreaterThan(0);
  });

  it('should read service info resource', async () => {
    const res = await app.request('/resources/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: 'service://info' }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.contents).toBeDefined();
    expect(data.contents[0].uri).toBe('service://info');
  });

  it('should return 404 for unknown resource', async () => {
    const res = await app.request('/resources/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: 'service://unknown' }),
    });
    expect(res.status).toBe(404);
  });

  it('should list prompts (empty)', async () => {
    const res = await app.request('/prompts/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(Array.isArray(data.prompts)).toBe(true);
    expect(data.prompts.length).toBe(0);
  });

  it('should return 404 for unknown prompt', async () => {
    const res = await app.request('/prompts/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'unknown' }),
    });
    expect(res.status).toBe(404);
  });

  it('should return 404 for tool call with unknown tool', async () => {
    const res = await app.request('/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'unknown_tool',
        arguments: {},
      }),
    });
    expect(res.status).toBe(404);
    
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32003);
  });

  it('should call get_status tool', async () => {
    const res = await app.request('/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'get_status',
        arguments: {},
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.content).toBeDefined();
    
    const content = JSON.parse(data.content[0].text);
    expect(content.status).toBe('healthy');
    expect(content.uptime).toBeDefined();
  });

  it('should set logging level', async () => {
    const res = await app.request('/logging/setLevel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });
    expect(res.status).toBe(200);
  });

  it('should reject invalid logging level', async () => {
    const res = await app.request('/logging/setLevel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'invalid' }),
    });
    expect(res.status).toBe(400);
    
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('should handle completion requests', async () => {
    const res = await app.request('/completion/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: { type: 'ref/resource' },
        argument: { name: 'uri', value: 'service://' },
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.completion).toBeDefined();
    expect(Array.isArray(data.completion.values)).toBe(true);
  });

  it('should handle resource subscription', async () => {
    const res = await app.request('/resources/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: 'service://info' }),
    });
    expect(res.status).toBe(200);
  });

  it('should handle resource unsubscription', async () => {
    const res = await app.request('/resources/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: 'service://info' }),
    });
    expect(res.status).toBe(200);
  });

  it('should return discovery info on GET /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.protocol).toBe('mcp');
    expect(data.protocolVersion).toBe('2024-11-05');
    expect(data.endpoints).toBeDefined();
  });
});

describe('A2A Server', () => {
  let a2aServer: ReturnType<typeof createA2AServer>;
  let app: Hono;

  beforeAll(() => {
    a2aServer = createA2AServer(testConfig);
    app = a2aServer.getRouter();
  });

  it('should return agent card', async () => {
    const res = await app.request('/.well-known/agent-card.json');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.protocolVersion).toBe('0.3.0');
    expect(data.name).toBe('Test Service');
    expect(Array.isArray(data.skills)).toBe(true);
  });

  it('should return health status', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('should handle get-info skill via text', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            messageId: 'test-1',
            parts: [{ kind: 'text', text: 'What can you do?' }],
          },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.jsonrpc).toBe('2.0');
    expect(data.result).toBeDefined();
    expect(data.result.role).toBe('agent');
    expect(data.result.parts).toBeDefined();
  });

  it('should handle echo skill via data', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            messageId: 'test-2',
            parts: [{ 
              kind: 'data', 
              data: { 
                skillId: 'echo', 
                params: { message: 'Hello from test!' } 
              } 
            }],
          },
        },
        id: 2,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.result).toBeDefined();
    
    const textPart = data.result.parts.find((p: { kind: string }) => p.kind === 'text');
    expect(textPart.text).toContain('Echo');
    expect(textPart.text).toContain('Hello from test!');
  });

  it('should handle get-status skill', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            messageId: 'test-3',
            parts: [{ 
              kind: 'data', 
              data: { skillId: 'get-status' } 
            }],
          },
        },
        id: 3,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.result).toBeDefined();
    
    const dataPart = data.result.parts.find((p: { kind: string }) => p.kind === 'data');
    expect(dataPart.data.status).toBe('healthy');
  });

  it('should reject unknown methods', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'unknown/method',
        params: {},
        id: 4,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32601);
  });

  it('should handle agent/describe method', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'agent/describe',
        params: {},
        id: 5,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.result).toBeDefined();
    expect(data.result.name).toBe('Test Service');
    expect(data.result.protocolVersion).toBe('0.3.0');
  });

  it('should handle skills/list method', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'skills/list',
        params: {},
        id: 6,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.result).toBeDefined();
    expect(Array.isArray(data.result.skills)).toBe(true);
    expect(data.result.skills.length).toBeGreaterThan(0);
  });

  it('should return skills via GET /skills', async () => {
    const res = await app.request('/skills');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(Array.isArray(data.skills)).toBe(true);
    expect(data.skills.length).toBeGreaterThan(0);
    
    const echoSkill = data.skills.find((s: { id: string }) => s.id === 'echo');
    expect(echoSkill).toBeDefined();
    expect(echoSkill.requiresPayment).toBe(false);
  });

  it('should handle tasks/send method', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/send',
        params: {
          message: {
            messageId: 'task-test-1',
            parts: [{ 
              kind: 'data', 
              data: { skillId: 'echo', params: { message: 'async task' } } 
            }],
          },
        },
        id: 100,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.result).toBeDefined();
    expect(data.result.id).toBeDefined();
    expect(data.result.state).toBe('submitted');
  });

  it('should handle tasks/get method', async () => {
    // First create a task
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/send',
        params: {
          message: {
            messageId: 'task-test-2',
            parts: [{ 
              kind: 'data', 
              data: { skillId: 'get-info' } 
            }],
          },
        },
        id: 101,
      }),
    });
    const createData = await createRes.json();
    const taskId = createData.result.id;

    // Wait a bit for async execution
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get the task
    const getRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/get',
        params: { id: taskId },
        id: 102,
      }),
    });
    expect(getRes.status).toBe(200);
    
    const getData = await getRes.json();
    expect(getData.result).toBeDefined();
    expect(getData.result.id).toBe(taskId);
  });

  it('should handle tasks/cancel method', async () => {
    // First create a task
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/send',
        params: {
          message: {
            messageId: 'task-test-3',
            parts: [{ 
              kind: 'data', 
              data: { skillId: 'echo', params: { message: 'cancel me' } } 
            }],
          },
        },
        id: 103,
      }),
    });
    const createData = await createRes.json();
    const taskId = createData.result.id;

    // Cancel the task
    const cancelRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/cancel',
        params: { id: taskId },
        id: 104,
      }),
    });
    expect(cancelRes.status).toBe(200);
    
    const cancelData = await cancelRes.json();
    expect(cancelData.result).toBeDefined();
    expect(cancelData.result.state).toBe('canceled');
  });

  it('should return error for unknown skill', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            messageId: 'test-err',
            parts: [{ 
              kind: 'data', 
              data: { skillId: 'unknown-skill' } 
            }],
          },
        },
        id: 7,
      }),
    });
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32602);
    expect(data.error.data.availableSkills).toBeDefined();
  });

  it('should reject invalid JSON-RPC', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'message/send', // Missing jsonrpc field
        id: 8,
      }),
    });
    expect(res.status).toBe(200); // JSON-RPC returns 200 with error in body
    
    const data = await res.json();
    expect(data.error.code).toBe(-32600); // Invalid Request (missing jsonrpc)
  });
});

describe('x402 Payment', () => {
  it('should create payment requirement with recipient', async () => {
    const { createPaymentRequirement, PAYMENT_TIERS } = await import('../x402');
    
    const requirement = createPaymentRequirement(
      '/test/resource',
      PAYMENT_TIERS.API_CALL_BASIC,
      'Test payment',
      {
        recipientAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        network: 'base-sepolia',
        serviceName: 'Test Service',
      }
    );
    
    expect(requirement).not.toBeNull();
    expect(requirement?.x402Version).toBe(1);
    expect(requirement?.accepts.length).toBe(1);
    expect(requirement?.accepts[0].scheme).toBe('exact');
    expect(requirement?.accepts[0].network).toBe('base-sepolia');
  });

  it('should return null for unsupported network without recipient', async () => {
    const { createPaymentRequirement, PAYMENT_TIERS } = await import('../x402');
    
    const requirement = createPaymentRequirement(
      '/test/resource',
      PAYMENT_TIERS.API_CALL_BASIC,
      'Test payment',
      {
        recipientAddress: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        network: 'ethereum', // No cloud support for ethereum
        serviceName: 'Test Service',
      }
    );
    
    // Should return null for unsupported network without recipient
    expect(requirement).toBeNull();
  });

  it('should use cloud contract for supported network without recipient', async () => {
    const { createPaymentRequirement, PAYMENT_TIERS, ELIZAOS_CLOUD_CONTRACTS } = await import('../x402');
    
    const requirement = createPaymentRequirement(
      '/test/resource',
      PAYMENT_TIERS.API_CALL_BASIC,
      'Test payment',
      {
        recipientAddress: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        network: 'base-sepolia', // Has cloud support
        serviceName: 'Test Service',
      }
    );
    
    // Should use cloud contract as payTo
    expect(requirement).not.toBeNull();
    expect(requirement?.accepts[0].payTo).toBe(ELIZAOS_CLOUD_CONTRACTS['base-sepolia']);
  });

  it('should parse payment header', async () => {
    const { parsePaymentHeader } = await import('../x402');
    
    const payload = {
      scheme: 'exact',
      network: 'base-sepolia',
      asset: '0x0000000000000000000000000000000000000000',
      payTo: '0x1234567890123456789012345678901234567890',
      amount: '100000000000000',
      resource: '/test',
      nonce: 'abc123',
      timestamp: Math.floor(Date.now() / 1000),
    };
    
    const parsed = parsePaymentHeader(JSON.stringify(payload));
    expect(parsed).not.toBeNull();
    expect(parsed?.scheme).toBe('exact');
    expect(parsed?.amount).toBe('100000000000000');
  });

  it('should reject invalid payment header', async () => {
    const { parsePaymentHeader } = await import('../x402');
    
    expect(parsePaymentHeader(null)).toBeNull();
    expect(parsePaymentHeader('')).toBeNull();
    expect(parsePaymentHeader('invalid')).toBeNull();
  });

  it('should get x402 status - disabled', async () => {
    const { getX402Status } = await import('../x402');
    
    const status = getX402Status({ enabled: false });
    
    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.mode).toBe('disabled');
  });

  it('should get x402 status - cloud mode (no recipient)', async () => {
    const { getX402Status } = await import('../x402');
    
    const status = getX402Status({
      enabled: true,
      network: 'base-sepolia',
      serviceName: 'Test',
    });
    
    // Should fallback to cloud mode
    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.mode).toBe('cloud');
    expect(status.facilitator).toContain('elizaos.ai');
  });

  it('should get x402 status - self-hosted mode (with recipient)', async () => {
    const { getX402Status } = await import('../x402');
    
    const status = getX402Status({
      enabled: true,
      recipientAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
      network: 'base-sepolia',
      serviceName: 'Test',
      facilitatorEndpoint: 'https://my-facilitator.example.com',
    });
    
    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.mode).toBe('self-hosted');
    expect(status.recipient).toBe('0x1234567890123456789012345678901234567890');
  });

  it('should create safe payment requirement with fallback', async () => {
    const { createPaymentRequirementSafe, PAYMENT_TIERS } = await import('../x402');
    
    // When explicitly disabled, should return null
    const nullReq = createPaymentRequirementSafe(
      '/test',
      PAYMENT_TIERS.API_CALL_BASIC,
      'Test',
      { enabled: false }
    );
    expect(nullReq).toBeNull();
    
    // When enabled with valid config, should return requirement
    const validReq = createPaymentRequirementSafe(
      '/test',
      PAYMENT_TIERS.API_CALL_BASIC,
      'Test',
      {
        enabled: true,
        recipientAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        network: 'base-sepolia',
        serviceName: 'Test',
      }
    );
    expect(validReq).not.toBeNull();
    expect(validReq?.accepts[0].extra?.mode).toBeDefined();
  });

  it('should identify supported cloud networks', async () => {
    const { hasCloudPaymentSupport, getSupportedCloudNetworks } = await import('../x402');
    
    expect(hasCloudPaymentSupport('base-sepolia')).toBe(true);
    expect(hasCloudPaymentSupport('ethereum')).toBe(false);
    expect(hasCloudPaymentSupport('base')).toBe(false); // Pending deployment
    
    const supported = getSupportedCloudNetworks();
    expect(supported).toContain('base-sepolia');
    expect(supported).not.toContain('ethereum');
  });

  it('should provide helpful error for unsupported network', async () => {
    const { getX402Status } = await import('../x402');
    
    const status = getX402Status({
      enabled: true,
      network: 'ethereum', // Not supported
      serviceName: 'Test',
    });
    
    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.error).toContain('ethereum');
    expect(status.error).toContain('base-sepolia'); // Should suggest supported network
  });
});
