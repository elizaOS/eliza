import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test';
import * as http from 'node:http';
import * as path from 'node:path';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { config } from 'dotenv';
import { getTunnelStatusAction } from '../../actions/get-tunnel-status';
import { startTunnelAction } from '../../actions/start-tunnel';
import { stopTunnelAction } from '../../actions/stop-tunnel';
import { NgrokService } from '../../services/NgrokService';
import { testConfig, testDelay } from '../test-config';
import { ngrokSafeDelay } from '../test-helpers';

// Load environment variables
config({ path: path.resolve(process.cwd(), '.env') });

type PortExtractionParams = {
  context?: {
    userMessage?: string;
  };
};

describe('Real ngrok API E2E Tests', () => {
  let runtime: IAgentRuntime;
  let service: NgrokService;
  let testServer: http.Server;
  let testServerPort: number;
  let skipTests = false;

  beforeAll(async () => {
    // Check if we should skip tests
    const hasAuthToken = Boolean(process.env.NGROK_AUTH_TOKEN);
    const skipEnvVar = process.env.SKIP_NGROK_TESTS === 'true';

    console.log('E2E test environment check:');
    console.log('- NGROK_AUTH_TOKEN:', hasAuthToken ? 'Set' : 'Not set');
    console.log('- NGROK_DOMAIN:', process.env.NGROK_DOMAIN || 'Not set (will use random URL)');
    console.log('- SKIP_NGROK_TESTS:', skipEnvVar);

    if (!hasAuthToken || skipEnvVar) {
      skipTests = true;
      console.log('⚠️  Skipping E2E tests');
      return;
    }

    // Add delay before starting the test suite
    await testDelay(testConfig.execution.suitesDelay);

    // Create a test HTTP server
    testServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();

        // Log the request for debugging
        console.log(`Received ${req.method} request to ${req.url}`);

        // Handle different endpoints
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
        } else if (req.url === '/webhook') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              received: true,
              method: req.method,
              headers: req.headers,
              body: body ? JSON.parse(body) : null,
            })
          );
        } else if (req.url === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body || JSON.stringify({ echo: 'empty' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    // Start server on random port
    await new Promise<void>((resolve) => {
      testServer.listen(0, () => {
        const address = testServer.address();
        if (address && typeof address === 'object') {
          testServerPort = address.port;
        }
        console.log(`✅ Test server started on port ${testServerPort}`);
        resolve();
      });
    });

    // Create runtime with real environment
    runtime = {
      agentId: 'test-agent',
      getSetting: (key: string) => process.env[key],
      getService: (name: string) => (name === 'tunnel' ? service : undefined),
      registerService: (_service: unknown) => {},
      useModel: async (_model: string, params: PortExtractionParams) => {
        // Return the port from the message content
        const portMatch = params.context?.userMessage?.match(/port (\d+)/);
        const port = portMatch ? parseInt(portMatch[1], 10) : 3000;
        return JSON.stringify({ port });
      },
    } as IAgentRuntime;

    // Initialize service
    service = new NgrokService(runtime);
  });

  afterAll(async () => {
    if (skipTests) {
      return;
    }

    // Clean up any active tunnels
    if (service?.isActive()) {
      await service.stopTunnel();
      await testDelay(testConfig.ngrok.stopWaitTime);
    }

    // Stop test server
    if (testServer) {
      await new Promise<void>((resolve) => {
        testServer.close(() => resolve());
      });
    }
  });

  beforeEach(async () => {
    if (skipTests) {
      return;
    }

    // Add delay before each test
    await testDelay();

    // Ensure clean state before each test
    if (service?.isActive()) {
      await service.stopTunnel();
      await testDelay(testConfig.ngrok.stopWaitTime);
    }
  });

  afterEach(async () => {
    if (skipTests) {
      return;
    }

    // Ensure tunnel is stopped after each test
    if (service?.isActive()) {
      await service.stopTunnel();
    }

    // Add delay after each test
    await testDelay();
  });

  // Helper function for making requests through ngrok
  async function fetchWithNgrokHeaders(url: string, options?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        'ngrok-skip-browser-warning': 'true',
      },
    });
  }

  describe('Basic Tunnel Operations', () => {
    it(
      'should start a tunnel with real ngrok',
      async () => {
        if (skipTests) {
          console.log('Test skipped - no auth token');
          return;
        }

        const url = await service.startTunnel(testServerPort);

        expect(url).toBeTruthy();
        expect(url).toMatch(/^https:\/\/[a-zA-Z0-9-]+\.ngrok(-free)?\.app$/);
        expect(service.isActive()).toBe(true);

        const status = service.getStatus();
        expect(status.active).toBe(true);
        expect(status.url).toBe(url as string | null);
        expect(status.port).toBe(testServerPort);
        expect(status.provider).toBe('ngrok');

        console.log(`✅ Tunnel created: ${url}`);
      },
      testConfig.execution.e2eTimeout
    );

    it(
      'should stop a tunnel',
      async () => {
        if (skipTests) {
          return;
        }

        // Start tunnel first
        const _url = await service.startTunnel(testServerPort);
        expect(service.isActive()).toBe(true);

        // Stop tunnel
        await service.stopTunnel();
        expect(service.isActive()).toBe(false);
        expect(service.getUrl()).toBeNull();

        const status = service.getStatus();
        expect(status.active).toBe(false);
        expect(status.url).toBeNull();
        expect(status.port).toBeNull();
      },
      testConfig.execution.e2eTimeout
    );

    it(
      'should handle multiple start/stop cycles',
      async () => {
        if (skipTests) {
          return;
        }

        for (let i = 0; i < 3; i++) {
          console.log(`\n🔄 Cycle ${i + 1}/3`);

          try {
            const url = await service.startTunnel(testServerPort);
            expect(url).toBeTruthy();
            expect(service.isActive()).toBe(true);

            await service.stopTunnel();
            expect(service.isActive()).toBe(false);

            // Use enhanced delay between cycles to ensure ngrok API is ready
            if (i < 2) {
              console.log('⏳ Waiting for ngrok to fully clean up...');
              await ngrokSafeDelay(testConfig.ngrok.minIntervalBetweenStarts + 2000);
            }
          } catch (error) {
            console.error(
              `❌ Cycle ${i + 1} failed:`,
              error instanceof Error ? error.message : String(error)
            );
            // If we get an error, wait extra time before continuing
            if (i < 2) {
              console.log('⏳ Extra wait after error...');
              await ngrokSafeDelay(5000);
            }
            throw error;
          }
        }
      },
      testConfig.execution.e2eTimeout * 2
    ); // Double timeout for this test
  });

  describe('Action Integration Tests', () => {
    it('should start tunnel via action', async () => {
      if (skipTests) {
        return;
      }

      const message: Memory = {
        id: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
        agentId: runtime.agentId,
        roomId:
          '00000000-0000-0000-0000-000000000003' as `${string}-${string}-${string}-${string}-${string}`,
        content: { text: `start tunnel on port ${testServerPort}` },
        createdAt: Date.now(),
      } as Memory;

      const callback = jest.fn().mockResolvedValue([]);
      const result = await startTunnelAction.handler(runtime, message, {} as State, {}, callback);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('started successfully'),
        metadata: {
          action: 'tunnel_started',
          tunnelUrl: expect.stringMatching(/^https:\/\/[a-zA-Z0-9-]+\.ngrok(-free)?\.app$/),
          port: testServerPort,
        },
      });

      expect(service.isActive()).toBe(true);
    }, 30000);

    it('should get tunnel status via action', async () => {
      if (skipTests) {
        return;
      }

      // Start tunnel first
      await service.startTunnel(testServerPort);
      const tunnelUrl = service.getUrl();

      const message: Memory = {
        id: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
        agentId: runtime.agentId,
        roomId:
          '00000000-0000-0000-0000-000000000003' as `${string}-${string}-${string}-${string}-${string}`,
        content: { text: 'tunnel status' },
        createdAt: Date.now(),
      } as Memory;

      const callback = jest.fn().mockResolvedValue([]);
      const result = await getTunnelStatusAction.handler(
        runtime,
        message,
        {} as State,
        {},
        callback
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(callback).toHaveBeenCalledWith({
        text: expect.stringContaining('Ngrok tunnel is active'),
        metadata: expect.objectContaining({
          action: 'tunnel_status',
          active: true,
          url: tunnelUrl,
          port: testServerPort,
          uptime: expect.any(String),
          provider: 'ngrok',
        }),
      });
    }, 30000);

    it('should stop tunnel via action', async () => {
      if (skipTests) {
        return;
      }

      // Start tunnel first
      const url = await service.startTunnel(testServerPort);
      expect(service.isActive()).toBe(true);

      const message: Memory = {
        id: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
        agentId: runtime.agentId,
        roomId:
          '00000000-0000-0000-0000-000000000003' as `${string}-${string}-${string}-${string}-${string}`,
        content: { text: 'stop tunnel' },
        createdAt: Date.now(),
      } as Memory;

      const callback = jest.fn().mockResolvedValue([]);
      const result = await stopTunnelAction.handler(runtime, message, {} as State, {}, callback);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('stopped successfully'),
          metadata: expect.objectContaining({
            previousUrl: url,
            previousPort: testServerPort,
          }),
        })
      );

      expect(service.isActive()).toBe(false);
    }, 30000);
  });

  describe('Real HTTP Traffic Tests', () => {
    it('should handle real HTTP requests through tunnel', async () => {
      if (skipTests) {
        return;
      }

      const tunnelUrl = (await service.startTunnel(testServerPort)) as string;

      // Test health endpoint
      const healthResponse = await fetchWithNgrokHeaders(`${tunnelUrl}/health`);
      const healthData = await healthResponse.json();

      expect(healthResponse.status).toBe(200);
      expect(healthData.status).toBe('healthy');
      expect(healthData.timestamp).toBeTruthy();
    }, 30000);

    it('should handle webhook requests through tunnel', async () => {
      if (skipTests) {
        return;
      }

      const tunnelUrl = (await service.startTunnel(testServerPort)) as string;

      // Send webhook request
      const webhookPayload = {
        event: 'test.webhook',
        timestamp: new Date().toISOString(),
        data: {
          message: 'Hello from ngrok tunnel',
          testId: Math.random().toString(36),
        },
      };

      const response = await fetchWithNgrokHeaders(`${tunnelUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': 'test-signature',
        },
        body: JSON.stringify(webhookPayload),
      });

      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData.received).toBe(true);
      expect(responseData.method).toBe('POST');
      expect(responseData.headers['x-webhook-signature']).toBe('test-signature');
      expect(responseData.body).toEqual(webhookPayload);
    }, 30000);

    it('should handle multiple concurrent requests', async () => {
      if (skipTests) {
        return;
      }

      const tunnelUrl = (await service.startTunnel(testServerPort)) as string;

      // Send 10 concurrent requests
      const requests = Array.from({ length: 10 }, async (_, i) => {
        const response = await fetchWithNgrokHeaders(`${tunnelUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: i, timestamp: Date.now() }),
        });
        return response.json();
      });

      const responses = await Promise.all(requests);

      expect(responses).toHaveLength(10);
      responses.forEach((response, i) => {
        expect(response.requestId).toBe(i);
        expect(response.timestamp).toBeTruthy();
      });
    }, 30000);
  });

  describe('Error Handling with Real API', () => {
    it('should handle port already in use', async () => {
      if (skipTests) {
        return;
      }

      // Start first tunnel
      const url1 = await service.startTunnel(testServerPort);
      expect(url1).toBeTruthy();

      // Try to start another tunnel on same port (should replace)
      const url2 = await service.startTunnel(testServerPort);
      expect(url2).toBeTruthy();
      expect(url2).toBe(url1); // Should be the same tunnel
    }, 30000);

    it('should handle invalid port gracefully', async () => {
      if (skipTests) {
        return;
      }

      try {
        // Use port 0 which is reserved and invalid for ngrok
        await service.startTunnel(0);
        throw new Error('Should have thrown an error');
      } catch (error) {
        expect(error).toBeTruthy();
        expect(service.isActive()).toBe(false);
      }
    }, 30000);

    it('should recover from network interruption', async () => {
      if (skipTests) {
        return;
      }

      // Start tunnel
      const url = await service.startTunnel(testServerPort);
      expect(url).toBeTruthy();

      // Stop and wait for cleanup
      await service.stopTunnel();
      console.log('⏳ Waiting for ngrok to fully stop...');
      await ngrokSafeDelay(3000); // Increased delay with API check

      // Restart tunnel
      console.log('🔄 Restarting tunnel...');
      const newUrl = await service.startTunnel(testServerPort);
      expect(newUrl).toBeTruthy();
      expect(service.isActive()).toBe(true);
    }, 30000);
  });

  describe('Slack Agent Use Cases', () => {
    it('should simulate Slack webhook events', async () => {
      if (skipTests) {
        return;
      }

      const tunnelUrl = (await service.startTunnel(testServerPort)) as string;

      // Simulate Slack event
      const slackEvent = {
        token: 'test-token',
        team_id: 'T1234567890',
        event: {
          type: 'message',
          channel: 'C1234567890',
          user: 'U1234567890',
          text: 'Hello from Slack!',
          ts: '1234567890.123456',
        },
      };

      const response = await fetchWithNgrokHeaders(`${tunnelUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': Date.now().toString(),
          'X-Slack-Signature': 'v0=test-signature',
        },
        body: JSON.stringify(slackEvent),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.received).toBe(true);
      expect(data.body.event.text).toBe('Hello from Slack!');
    }, 30000);
  });
});
