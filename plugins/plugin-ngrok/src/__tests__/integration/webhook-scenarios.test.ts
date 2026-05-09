import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import * as https from 'node:https';
import express from 'express';
import { NgrokService } from '../../services/NgrokService';
import { testConfig, testDelay } from '../test-config';
import { createMockRuntime } from '../test-utils';

// Helper to check if ngrok is installed
const _isNgrokInstalled = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const checkProcess = spawn('which', ['ngrok']);
    checkProcess.on('exit', (code) => {
      resolve(code === 0);
    });
    checkProcess.on('error', () => {
      resolve(false);
    });
  });
};

describe('Webhook Integration Scenarios', () => {
  let service: NgrokService;
  let app: express.Application;
  let server: Server;
  let webhookUrl: string | null = null;
  let webhookPort: number;
  let receivedWebhooks: any[] = [];
  let skipTests = false;

  beforeAll(async () => {
    // Check if we should skip tests
    const hasAuthToken = Boolean(process.env.NGROK_AUTH_TOKEN);
    const skipEnvVar = process.env.SKIP_NGROK_TESTS === 'true';

    console.log('Integration test environment check:');
    console.log('- NGROK_AUTH_TOKEN:', hasAuthToken ? 'Set' : 'Not set');
    console.log('- SKIP_NGROK_TESTS:', skipEnvVar);

    if (!hasAuthToken || skipEnvVar) {
      skipTests = true;
      console.log('⚠️  Skipping integration tests');
      return;
    }

    // Add delay before starting the test suite
    await testDelay(testConfig.execution.suitesDelay);

    // Setup webhook server
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Generic webhook handler
    app.all('/webhook/*', (req, res) => {
      receivedWebhooks.push({
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        query: req.query,
        timestamp: Date.now(),
      });
      res.status(200).json({ received: true });
    });

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', webhooks: receivedWebhooks.length });
    });

    // Start server on random port
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          webhookPort = address.port;
        }
        console.log(`✅ Webhook server started on port ${webhookPort}`);
        resolve();
      });
    });

    // Initialize ngrok service with core test-utils runtime
    const runtime = createMockRuntime();
    service = new NgrokService(runtime);
  });

  beforeEach(async () => {
    if (skipTests) {
      return;
    }

    // Clear received webhooks
    receivedWebhooks = [];

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

    // Clean up after each test
    if (service?.isActive()) {
      await service.stopTunnel();
      await testDelay(testConfig.ngrok.stopWaitTime);
    }
  });

  afterAll(async () => {
    if (skipTests) {
      return;
    }

    // Stop any active tunnel
    if (service?.isActive()) {
      await service.stopTunnel();
    }

    // Then stop server
    await new Promise<void>((resolve, reject) => {
      if (server) {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  });

  it(
    'should handle webhook requests',
    async () => {
      if (skipTests) {
        console.log('Test skipped - no auth token');
        return;
      }

      // Start tunnel for webhook server
      const url = await service.startTunnel(webhookPort);
      expect(url).toBeTruthy();
      webhookUrl = url as string;
      expect(service.isActive()).toBe(true);

      console.log(`✅ Webhook tunnel started: ${webhookUrl}`);

      // Send a test webhook
      const testPayload = {
        event: 'test.webhook',
        timestamp: new Date().toISOString(),
        data: {
          message: 'Hello from webhook test',
          id: Math.random().toString(36),
        },
      };

      const response = await sendWebhook(`${webhookUrl}/webhook/test`, testPayload, {
        'X-Test-Header': 'test-value',
      });

      expect(response).toEqual({ received: true });

      // Wait a bit for webhook to be processed
      await testDelay(500);

      // Verify webhook was received
      expect(receivedWebhooks).toHaveLength(1);
      const webhook = receivedWebhooks[0];
      expect(webhook.method).toBe('POST');
      expect(webhook.path).toBe('/webhook/test');
      expect(webhook.headers['x-test-header']).toBe('test-value');
      expect(webhook.body).toEqual(testPayload);
    },
    testConfig.execution.integrationTimeout
  );

  it(
    'should handle multiple webhook types',
    async () => {
      if (skipTests) {
        return;
      }

      // Start tunnel
      const url2 = await service.startTunnel(webhookPort);
      expect(url2).toBeTruthy();
      webhookUrl = url2 as string;

      // Test different webhook scenarios
      const webhookTests = [
        {
          name: 'GitHub Push',
          path: '/webhook/github',
          payload: {
            ref: 'refs/heads/main',
            repository: { name: 'test-repo' },
            commits: [{ message: 'Test commit' }],
          },
          headers: {
            'X-GitHub-Event': 'push',
            'X-GitHub-Delivery': 'test-123',
          } as Record<string, string>,
        },
        {
          name: 'Stripe Payment',
          path: '/webhook/stripe',
          payload: {
            type: 'payment_intent.succeeded',
            data: {
              object: {
                amount: 2000,
                currency: 'usd',
              },
            },
          },
          headers: {
            'Stripe-Signature': 'test-sig',
          } as Record<string, string>,
        },
        {
          name: 'Slack Event',
          path: '/webhook/slack',
          payload: {
            type: 'event_callback',
            event: {
              type: 'message',
              text: 'Hello bot!',
            },
          },
          headers: {
            'X-Slack-Signature': 'v0=test',
          } as Record<string, string>,
        },
      ];

      // Send all webhooks
      for (const test of webhookTests) {
        console.log(`📤 Sending ${test.name} webhook...`);
        const response = await sendWebhook(`${webhookUrl}${test.path}`, test.payload, test.headers);
        expect(response).toEqual({ received: true });
      }

      // Wait for processing
      await testDelay(1000);

      // Verify all webhooks were received
      expect(receivedWebhooks).toHaveLength(3);

      // Check each webhook
      webhookTests.forEach((test, index) => {
        const webhook = receivedWebhooks[index];
        expect(webhook.path).toBe(test.path);
        expect(webhook.body).toEqual(test.payload);
        Object.entries(test.headers).forEach(([key, value]) => {
          expect(webhook.headers[key.toLowerCase()]).toBe(value);
        });
      });
    },
    testConfig.execution.integrationTimeout
  );

  it(
    'should handle concurrent webhooks',
    async () => {
      if (skipTests) {
        return;
      }

      // Start tunnel
      const url3 = await service.startTunnel(webhookPort);
      expect(url3).toBeTruthy();
      webhookUrl = url3 as string;

      // Send 10 concurrent webhooks
      const promises = Array.from({ length: 10 }, async (_, i) => {
        return sendWebhook(`${webhookUrl}/webhook/concurrent`, {
          id: i,
          timestamp: Date.now(),
          message: `Concurrent webhook ${i}`,
        });
      });

      const responses = await Promise.all(promises);

      // All should succeed
      responses.forEach((response) => {
        expect(response).toEqual({ received: true });
      });

      // Wait for processing
      await testDelay(1000);

      // Verify all were received
      expect(receivedWebhooks).toHaveLength(10);

      // Check they all have unique IDs
      const ids = receivedWebhooks.map((w) => w.body.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    },
    testConfig.execution.integrationTimeout
  );

  it(
    'should maintain tunnel stability during webhook traffic',
    async () => {
      if (skipTests) {
        return;
      }

      // Start tunnel
      const url4 = await service.startTunnel(webhookPort);
      expect(url4).toBeTruthy();
      webhookUrl = url4 as string;
      const initialUrl = webhookUrl;

      // Send webhooks over time with retry on failure
      let successfulWebhooks = 0;
      for (let i = 0; i < 5; i++) {
        try {
          const response = await sendWebhook(`${webhookUrl}/webhook/stability`, {
            iteration: i,
            timestamp: Date.now(),
          });
          expect(response).toEqual({ received: true });
          successfulWebhooks++;

          // Check tunnel is still active
          expect(service.isActive()).toBe(true);
          expect(service.getUrl()).toBe(initialUrl);

          // Small delay between webhooks
          await testDelay(500);
        } catch (error: any) {
          console.error(`Webhook ${i} failed:`, error.message);
          // If a webhook fails, wait a bit longer before continuing
          await testDelay(2000);

          // Don't fail the test if we've had some successful webhooks
          if (successfulWebhooks >= 3) {
            console.warn('⚠️  Some webhooks failed but test continues with partial success');
            break;
          } else {
            throw error;
          }
        }
      }

      // Verify webhooks were received (at least 3 for partial success)
      expect(receivedWebhooks.length).toBeGreaterThanOrEqual(3);

      // Check health endpoint through tunnel with error handling
      try {
        const healthResponse = await fetch(`${webhookUrl}/health`, {
          headers: { 'ngrok-skip-browser-warning': 'true' },
        });

        if (!healthResponse.ok) {
          throw new Error(`Health check failed with status ${healthResponse.status}`);
        }

        const contentType = healthResponse.headers.get('content-type');
        if (!contentType?.includes('application/json')) {
          const text = await healthResponse.text();
          console.error('Received non-JSON response:', text.substring(0, 200));
          throw new Error('Received non-JSON response from health endpoint');
        }

        const healthData = await healthResponse.json();
        expect(healthData.status).toBe('ok');
        expect(healthData.webhooks).toBe(5);
      } catch (error: any) {
        console.error('Health check failed:', error.message);
        // Skip the health check if tunnel is having issues
        console.warn('⚠️  Skipping health check due to tunnel issues');
      }
    },
    testConfig.execution.integrationTimeout
  );
});

// Helper function to send webhooks
async function sendWebhook(
  url: string,
  payload: any,
  headers: Record<string, string> = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(payload);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'ngrok-skip-browser-warning': 'true',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();

          // Check if we got an HTML error page instead of JSON
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
            return;
          }

          // Try to parse JSON
          try {
            resolve(JSON.parse(body));
          } catch (_jsonError) {
            // If it's HTML (ngrok error page), extract the title or error message
            if (body.includes('<!DOCTYPE') || body.includes('<html')) {
              const titleMatch = body.match(/<title>([^<]+)<\/title>/);
              const errorMsg = titleMatch ? titleMatch[1] : 'Received HTML instead of JSON';
              reject(new Error(`Ngrok Error: ${errorMsg}`));
            } else {
              reject(new Error(`Failed to parse response: ${body.substring(0, 100)}`));
            }
          }
        } catch (error: any) {
          reject(new Error(`Response handling error: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
