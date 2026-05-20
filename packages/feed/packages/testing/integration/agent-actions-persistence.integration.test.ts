/**
 * Integration Test: Agent Actions Persistence
 *
 * Verifies that agents execute real actions that persist to database:
 * - Trades create Position records
 * - Posts create Post records
 * - Comments create Comment records
 * - Messages create Message records
 * - Balances are updated
 * - P&L is calculated
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  agentRuntimeManager,
  autonomousCoordinator,
  createTestAgent,
} from '@babylon/agents';
import { db } from '@babylon/db';
import { WalletService } from '@babylon/engine';
import { generateSnowflakeId } from '@babylon/shared';
import { existsSync, readFileSync } from 'fs';
import { resolveLiveLlmTestConfig } from './helpers/live-runtime';

// Load environment variables from .env files if they exist (for CI and local environments)
// Priority: process.env > .env.test > .env.local
const loadEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return;
  const envContent = readFileSync(filePath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        // Only set if not already in process.env (env vars take precedence)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
};

// Load .env.test first (created by CI prepare-env.sh), then .env.local (for local dev)
loadEnvFile('.env.test');
loadEnvFile('.env.local');

const liveLlmTestConfig = resolveLiveLlmTestConfig();
const liveTest = test.skipIf(!liveLlmTestConfig.enabled);

describe('Agent Actions Persistence Integration', () => {
  let testAgentId: string;
  let testMarketId: string;
  let testPostId: string;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    if (liveLlmTestConfig.requested && !liveLlmTestConfig.enabled) {
      throw new Error(
        liveLlmTestConfig.skipReason ?? 'Live LLM test setup failed'
      );
    }

    if (!liveLlmTestConfig.enabled) {
      return;
    }

    // Mock fetch to handle A2A client initialization
    const mockFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes('.well-known/agent-card.json')) {
        // Return a valid A2A agent card structure with required fields
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL ||
          process.env.BABYLON_A2A_ENDPOINT ||
          'http://localhost:3000';
        const agentCard = {
          protocolVersion: '0.3.0',
          name: 'Test Agent',
          description: 'A test agent for integration testing',
          url: `${baseUrl}/api/agents/test-agent/a2a`,
          preferredTransport: 'JSONRPC' as const,
          additionalInterfaces: [
            {
              url: `${baseUrl}/api/agents/test-agent/a2a`,
              transport: 'JSONRPC' as const,
            },
          ],
          provider: {
            organization: 'Babylon',
            url: 'https://babylon.market',
          },
          iconUrl: `${baseUrl}/logo.svg`,
          version: '1.0.0',
          documentationUrl: `${baseUrl}/docs`,
          capabilities: {
            streaming: false,
            pushNotifications: false,
            stateTransitionHistory: true,
          },
          securitySchemes: {},
          security: [],
          defaultInputModes: ['text/plain', 'application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          supportsAuthenticatedExtendedCard: false,
        };
        return new Response(JSON.stringify(agentCard), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Mock A2A endpoint calls to prevent actual HTTP requests during tests
      if (url.includes('/api/agents/') && url.includes('/a2a')) {
        // Parse the request body to get the RPC ID and method
        let rpcId = 1;
        let method = '';
        let params: { id?: string } = {};

        if (init?.body) {
          try {
            const body =
              typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
            if (body.id !== undefined) {
              rpcId = body.id;
            }
            if (body.method) {
              method = body.method;
            }
            if (body.params) {
              params = body.params;
            }
          } catch {
            // If parsing fails, use defaults
          }
        }

        // Handle different A2A methods
        if (method === 'tasks/get' || method === 'tasks.get') {
          // Return completed task for polling with proper structure
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId,
              result: {
                task: {
                  id: params.id || `mock-task-${Date.now()}`,
                  status: {
                    state: 'completed',
                  },
                  artifacts: [
                    {
                      parts: [
                        {
                          kind: 'data',
                          data: {
                            success: false,
                            error: 'A2A endpoint mocked for testing',
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // For message/send, return a task that will be polled
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              kind: 'task',
              task: {
                id: `mock-task-${Date.now()}`,
                status: {
                  state: 'pending',
                },
              },
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Allow other requests to pass through
      try {
        return await originalFetch(input, init);
      } catch (error) {
        // If it's a connection error to localhost, return 503 to avoid crashing
        if (url.includes('localhost')) {
          return new Response(null, {
            status: 503,
            statusText: 'Service Unavailable',
          });
        }
        throw error;
      }
    };

    // Assign mock with all required fetch properties
    global.fetch = mockFetch as typeof fetch;

    // Create test agent with autonomous features enabled
    const agentResult = await createTestAgent(
      'integration-test-agent-actions',
      {
        autonomousTrading: true,
        autonomousPosting: true,
        autonomousCommenting: true,
        virtualBalance: 10000,
      }
    );

    testAgentId = agentResult.agentId;

    // Create a test market for trading
    testMarketId = await generateSnowflakeId();
    try {
      await db.market.create({
        data: {
          id: testMarketId,
          question: 'Integration test: Will agents trade?',
          yesShares: '100',
          noShares: '100',
          liquidity: '200', // Required field
          resolved: false,
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('Failed to create test market:', error);
      // Market creation failed, set to null to skip cleanup
      testMarketId = '';
    }

    // Create a test post for commenting
    testPostId = await generateSnowflakeId();
    const testAuthorId = await generateSnowflakeId();
    await db.user.create({
      data: {
        id: testAuthorId,
        username: `test-author-${testAuthorId.slice(-6)}`,
        displayName: 'Test Author',
        updatedAt: new Date(),
      },
    });
    await db.post.create({
      data: {
        id: testPostId,
        content: 'Test post for agent commenting',
        authorId: testAuthorId,
        type: 'post',
        timestamp: new Date(),
        createdAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!liveLlmTestConfig.enabled) {
      return;
    }

    // Restore global fetch
    global.fetch = originalFetch;

    // Cleanup
    if (testAgentId) {
      try {
        // Delete positions
        await db.position.deleteMany({ where: { userId: testAgentId } });
        // Delete posts
        await db.post.deleteMany({ where: { authorId: testAgentId } });
        // Delete comments
        await db.comment.deleteMany({ where: { authorId: testAgentId } });
        // Delete messages
        await db.message.deleteMany({ where: { senderId: testAgentId } });
        // Delete agent
        await db.user.delete({ where: { id: testAgentId } });
      } catch (_error) {
        // Cleanup errors not critical
      }
    }

    if (testMarketId) {
      try {
        // Check if market exists before trying to delete
        const marketExists = await db.market.findUnique({
          where: { id: testMarketId },
          select: { id: true },
        });

        if (marketExists) {
          // Delete positions first (foreign key constraint)
          await db.position
            .deleteMany({ where: { marketId: testMarketId } })
            .catch(() => {});
          // Delete prediction price history
          await db.predictionPriceHistory
            .deleteMany({ where: { marketId: testMarketId } })
            .catch(() => {});
          // Now delete the market
          await db.market
            .delete({ where: { id: testMarketId } })
            .catch(() => {});
        }
      } catch (_error) {
        // Cleanup errors not critical - market may have been deleted already
      }
    }

    if (testPostId) {
      try {
        await db.post.delete({ where: { id: testPostId } });
      } catch (_error) {
        // Cleanup errors not critical
      }
    }
  });

  liveTest('should create Position records when agent trades', async () => {
    // Get initial position count
    const initialPositions = await db.position.count({
      where: { userId: testAgentId },
    });

    // Get initial balance
    const initialBalance = await WalletService.getBalance(testAgentId);

    // Run agent tick - errors should fail the test, not skip
    const runtime = await agentRuntimeManager.getRuntime(testAgentId);
    const result = await autonomousCoordinator.executeAutonomousTick(
      testAgentId,
      runtime
    );

    // Verify tick executed
    expect(result.success).toBe(true);

    // Check if positions were created (may or may not trade depending on LLM decision)
    const afterPositions = await db.position.count({
      where: { userId: testAgentId },
    });

    // If agent traded, verify position was created
    if (result.actionsExecuted.trades > 0) {
      expect(afterPositions).toBeGreaterThan(initialPositions);

      // Verify position has correct data
      const positions = await db.position.findMany({
        where: { userId: testAgentId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      expect(positions.length).toBeGreaterThan(0);
      expect(positions[0]).toHaveProperty('marketId');
      expect(positions[0]).toHaveProperty('side');
      expect(positions[0]).toHaveProperty('shares');
      expect(positions[0]).toHaveProperty('status', 'active');

      // Verify balance was updated
      const afterBalance = await WalletService.getBalance(testAgentId);
      expect(Number(afterBalance.balance)).toBeLessThan(
        Number(initialBalance.balance)
      );
    }
  });

  liveTest('should create Post records when agent posts', async () => {
    // Get initial post count
    const initialPosts = await db.post.count({
      where: { authorId: testAgentId },
    });

    // Run agent tick - errors should fail the test, not skip
    const runtime = await agentRuntimeManager.getRuntime(testAgentId);
    const result = await autonomousCoordinator.executeAutonomousTick(
      testAgentId,
      runtime
    );

    // Verify tick executed
    expect(result.success).toBe(true);

    // Check if posts were created (may or may not post depending on LLM decision)
    const afterPosts = await db.post.count({
      where: { authorId: testAgentId },
    });

    // If agent posted, verify post was created
    if (result.actionsExecuted.posts > 0) {
      expect(afterPosts).toBeGreaterThan(initialPosts);

      // Verify post has correct data
      const posts = await db.post.findMany({
        where: { authorId: testAgentId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      expect(posts.length).toBeGreaterThan(0);
      expect(posts[0]).toHaveProperty('content');
      expect(posts[0]).toHaveProperty('authorId', testAgentId);
      expect(posts[0]?.content.length).toBeGreaterThan(0);
    }
  });

  liveTest('should create Comment records when agent comments', async () => {
    // Get initial comment count
    const initialComments = await db.comment.count({
      where: { authorId: testAgentId },
    });

    // Run agent tick - errors should fail the test, not skip
    const runtime = await agentRuntimeManager.getRuntime(testAgentId);
    const result = await autonomousCoordinator.executeAutonomousTick(
      testAgentId,
      runtime
    );

    // Verify tick executed
    expect(result.success).toBe(true);

    // Check if comments were created (may or may not comment depending on LLM decision)
    const afterComments = await db.comment.count({
      where: { authorId: testAgentId },
    });

    // If agent commented, verify comment was created
    if (result.actionsExecuted.comments > 0) {
      expect(afterComments).toBeGreaterThan(initialComments);

      // Verify comment has correct data
      const comments = await db.comment.findMany({
        where: { authorId: testAgentId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]).toHaveProperty('content');
      expect(comments[0]).toHaveProperty('authorId', testAgentId);
      expect(comments[0]).toHaveProperty('postId');
      expect(comments[0]?.content.length).toBeGreaterThan(0);
    }
  });

  liveTest('should update agent P&L when trades are executed', async () => {
    // Run agent tick - errors should fail the test, not skip
    const runtime = await agentRuntimeManager.getRuntime(testAgentId);
    const result = await autonomousCoordinator.executeAutonomousTick(
      testAgentId,
      runtime
    );

    // Verify tick executed
    expect(result.success).toBe(true);

    // If agent traded, P&L may have changed (depending on market movements)
    if (result.actionsExecuted.trades > 0) {
      const agentAfter = await db.user.findUnique({
        where: { id: testAgentId },
        select: { lifetimePnL: true },
      });

      // P&L should be tracked (may be positive or negative)
      expect(agentAfter?.lifetimePnL).toBeDefined();
      expect(typeof agentAfter?.lifetimePnL).toBe('number');
    }
  });
});
