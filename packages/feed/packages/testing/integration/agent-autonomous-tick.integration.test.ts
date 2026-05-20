/**
 * Integration Test: Agent Autonomous Tick Endpoint
 *
 * Verifies that the agent tick endpoint works end-to-end for a targeted
 * user-controlled agent:
 * - Endpoint is callable
 * - Requested agent is selected and processed
 * - agentLastTickAt is updated after each attempt
 * - Agent logs are created on success and failure paths
 * - Tick cost accounting matches the configured per-tick charge
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestAgent, getAgentConfig } from '@babylon/agents';
import {
  and,
  asSystem,
  balanceTransactions,
  db,
  desc,
  eq,
  generationLocks,
  inArray,
  users,
} from '@babylon/db';
import { generateSnowflakeId } from '@babylon/shared';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let cronEndpointAvailable = false;
const RETRYABLE_SKIP_REASONS = new Set([
  'Previous tick still running',
  'Game is paused',
  'No continuous game found',
]);

type AgentTickResult = {
  agentId: string;
  name: string;
  status: string;
  error?: string;
  duration: number;
  pointsDeducted?: number;
  actions?: number;
  method?: 'database' | 'a2a' | 'planning_coordinator' | 'multi_step';
};

type AgentTickResponse = {
  success: boolean;
  processed: number;
  tickPointsCost: number;
  skipped?: boolean;
  reason?: string;
  requestedAgentIds?: string[];
  results?: AgentTickResult[];
};

describe('Agent Autonomous Tick Integration', () => {
  let testAgentId: string;
  let initialLastTickAt: Date | null;
  let createdGameId: string | null = null;
  let initialGameRunning: boolean | undefined;
  let tickResponse: AgentTickResponse | null = null;
  let preTickBalance = 0;

  const clearAgentTickLock = async (): Promise<void> => {
    const lockIds = ['agent-tick-global'];
    if (testAgentId) {
      lockIds.push(`agent-tick-${testAgentId}`);
    }

    await asSystem(async (db) => {
      await db
        .delete(generationLocks)
        .where(inArray(generationLocks.id, lockIds));
    }, 'agent-tick-test-clear-global-lock');
  };

  const ensureContinuousGameRunning = async (): Promise<void> => {
    const gameState = await asSystem(async (db) => {
      return await db.game.findFirst({
        where: { isContinuous: true },
      });
    }, 'agent-tick-test-get-game-state');

    if (!gameState) {
      const newGameId = await generateSnowflakeId();
      createdGameId ??= newGameId;
      await asSystem(async (db) => {
        await db.game.create({
          data: {
            id: newGameId,
            isContinuous: true,
            isRunning: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }, 'agent-tick-test-create-game-state');
      return;
    }

    await asSystem(async (db) => {
      await db.game.updateMany({
        where: { isContinuous: true },
        data: { isRunning: true },
      });
    }, 'agent-tick-test-enable-game');
  };

  const getTickUrl = () => {
    const url = new URL(`${BASE_URL}/api/cron/agent-tick`);
    url.searchParams.set('agentId', testAgentId);
    return url.toString();
  };

  const getTestAgentResult = (
    result: AgentTickResponse
  ): AgentTickResult | undefined =>
    result.results?.find((entry) => entry.agentId === testAgentId);

  const executeTargetedTick = async (): Promise<AgentTickResponse> => {
    if (tickResponse) {
      return tickResponse;
    }

    let agentBefore = null;
    let configBefore = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matchingUsers = await db
        .select({
          id: users.id,
          isAgent: users.isAgent,
          virtualBalance: users.virtualBalance,
        })
        .from(users)
        .where(eq(users.id, testAgentId))
        .limit(1);
      agentBefore = matchingUsers[0] ?? null;
      configBefore = await getAgentConfig(testAgentId);
      if (
        agentBefore?.isAgent &&
        (configBefore?.autonomousTrading ||
          configBefore?.autonomousPosting ||
          configBefore?.autonomousCommenting)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(agentBefore).toBeTruthy();
    expect(agentBefore?.isAgent).toBe(true);
    expect(
      configBefore?.autonomousTrading ||
        configBefore?.autonomousPosting ||
        configBefore?.autonomousCommenting
    ).toBe(true);

    preTickBalance = Number(agentBefore?.virtualBalance ?? 0);

    const cronSecret = process.env.CRON_SECRET || 'development';
    let lastResult: AgentTickResponse | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clearAgentTickLock();
      await ensureContinuousGameRunning();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const response = await fetch(getTickUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(120_000),
      });

      expect(response.ok).toBe(true);
      lastResult = (await response.json()) as AgentTickResponse;

      if (
        lastResult.skipped !== true ||
        !RETRYABLE_SKIP_REASONS.has(lastResult.reason ?? '') ||
        attempt === 2
      ) {
        tickResponse = lastResult;
        return tickResponse;
      }

      console.warn(
        `Retrying agent tick after transient skip: ${lastResult.reason}`
      );
    }

    throw new Error('Agent tick did not return a response');
  };

  beforeAll(async () => {
    console.log('Starting beforeAll setup...');
    await clearAgentTickLock();

    try {
      console.log(`Checking health at ${BASE_URL}/api/health`);
      const response = await fetch(`${BASE_URL}/api/health`);
      serverAvailable = response.ok;
      console.log('Server available:', serverAvailable);
    } catch (e) {
      console.log('Server check failed:', e);
      serverAvailable = false;
    }

    if (!serverAvailable) {
      throw new Error(
        'AGENT TICK TESTS REQUIRE RUNNING SERVER. ' +
          'Start the server with `bun run dev` before running these tests. ' +
          'These tests validate actual server functionality and MUST NOT be skipped.'
      );
    }

    cronEndpointAvailable = true;

    console.log('Ensuring continuous game exists...');
    const gameState = await asSystem(async (db) => {
      return await db.game.findFirst({
        where: { isContinuous: true },
      });
    }, 'agent-tick-test-get-game-state');
    initialGameRunning = gameState?.isRunning;
    await ensureContinuousGameRunning();
    if (!gameState) {
      console.log('Created continuous game:', createdGameId);
    } else if (!gameState.isRunning) {
      console.log('Enabled existing continuous game');
    } else {
      console.log('Continuous game already exists and running');
    }

    console.log('Creating test agent...');
    const uniquePrefix = `integration-test-agent-tick-${Date.now()}`;
    const agentResult = await createTestAgent(uniquePrefix, {
      autonomousTrading: true,
      autonomousPosting: true,
      autonomousCommenting: true,
      virtualBalance: 10000,
    });
    console.log('Test agent created:', agentResult.agentId);

    testAgentId = agentResult.agentId;

    console.log('Getting initial state...');
    const config = await getAgentConfig(testAgentId);
    console.log('Initial state got.');

    try {
      console.log('DATABASE_URL:', process.env.DATABASE_URL);
      const { agentRegistry } = await import(
        '@babylon/agents/services/agent-registry.service'
      );
      const { AgentType, AgentStatus } = await import('@babylon/agents');
      const found = await agentRegistry.discoverAgents({
        types: [AgentType.USER_CONTROLLED],
        statuses: [
          AgentStatus.ACTIVE,
          AgentStatus.INITIALIZED,
          AgentStatus.REGISTERED,
        ],
        limit: 100,
      });
      console.log('Local AgentRegistry discovery count:', found.length);
      const foundIds = found.map((agent) => agent.agentId);
      console.log('Found IDs:', JSON.stringify(foundIds, null, 2));
      console.log('Test Agent ID:', testAgentId);
      console.log('Is found?', foundIds.includes(testAgentId));
    } catch (e) {
      console.log('Local AgentRegistry discovery failed:', e);
    }

    initialLastTickAt = config?.lastTickAt || null;
  });

  afterAll(async () => {
    await clearAgentTickLock();

    if (initialGameRunning !== undefined) {
      await asSystem(async (db) => {
        await db.game.updateMany({
          where: { isContinuous: true },
          data: { isRunning: initialGameRunning },
        });
      }, 'agent-tick-test-restore-game-state');
    }

    if (createdGameId) {
      try {
        await db.game.delete({ where: { id: createdGameId } });
      } catch (_error) {
        // Cleanup errors are not test failures.
      }
    }

    if (testAgentId) {
      try {
        await db.user.delete({ where: { id: testAgentId } });
      } catch (_error) {
        // Cleanup errors are not test failures.
      }
    }
  });

  test('should call agent tick endpoint successfully', async () => {
    expect(serverAvailable).toBe(true);
    expect(cronEndpointAvailable).toBe(true);

    const result = await executeTargetedTick();

    expect(result.success).toBe(true);
    expect(result.requestedAgentIds).toEqual([testAgentId]);
    expect(result.skipped).not.toBe(true);
    expect(result.processed).toBe(1);
  }, 120000);

  test('should find and process the requested agent', async () => {
    expect(serverAvailable).toBe(true);
    expect(cronEndpointAvailable).toBe(true);

    const result = await executeTargetedTick();
    const agentResult = getTestAgentResult(result);

    expect(Array.isArray(result.results)).toBe(true);
    expect(agentResult).toBeTruthy();
    expect(agentResult?.agentId).toBe(testAgentId);
  }, 120000);

  test('should update agentLastTickAt after tick attempt', async () => {
    expect(serverAvailable).toBe(true);
    expect(cronEndpointAvailable).toBe(true);

    const result = await executeTargetedTick();
    expect(result.success).toBe(true);

    let agentUser = null;
    let agentConfig = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matchingUsers = await db
        .select({
          id: users.id,
          isAgent: users.isAgent,
        })
        .from(users)
        .where(eq(users.id, testAgentId))
        .limit(1);
      agentUser = matchingUsers[0] ?? null;
      agentConfig = await getAgentConfig(testAgentId);
      if (agentUser && agentConfig?.lastTickAt) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(agentUser).toBeTruthy();
    expect(agentUser?.isAgent).toBe(true);
    expect(agentConfig).toBeTruthy();
    expect(agentConfig?.lastTickAt).toBeTruthy();
    expect(agentConfig?.status).toMatch(/running|error/);

    if (initialLastTickAt && agentConfig?.lastTickAt) {
      expect(new Date(agentConfig.lastTickAt).getTime()).toBeGreaterThan(
        initialLastTickAt.getTime()
      );
    }
  }, 120000);

  test('should create agent logs after tick attempt', async () => {
    expect(serverAvailable).toBe(true);
    expect(cronEndpointAvailable).toBe(true);

    const result = await executeTargetedTick();
    const agentResult = getTestAgentResult(result);
    const logs = await db.agentLog.findMany({
      where: {
        agentUserId: testAgentId,
        type: 'tick',
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 1,
    });

    expect(agentResult).toBeTruthy();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toHaveProperty('message');
    expect(logs[0]).toHaveProperty('metadata');
    expect(logs[0]?.metadata).toHaveProperty('success');
    expect(logs[0]?.metadata).toHaveProperty('pointsCost');
    expect(logs[0]?.metadata).toHaveProperty('actions');

    if (agentResult?.status === 'error' || agentResult?.status === 'timeout') {
      expect(logs[0]?.metadata).toHaveProperty('error');
    }
  }, 120000);

  test('should record the configured tick cost consistently', async () => {
    expect(serverAvailable).toBe(true);
    expect(cronEndpointAvailable).toBe(true);

    const result = await executeTargetedTick();
    const tickTransactions = await db
      .select()
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, testAgentId),
          eq(balanceTransactions.type, 'agent_tick')
        )
      )
      .orderBy(desc(balanceTransactions.createdAt));

    if (result.tickPointsCost > 0) {
      expect(tickTransactions.length).toBeGreaterThan(0);
      expect(Number(tickTransactions[0]?.amount ?? 0)).toBe(
        -result.tickPointsCost
      );
      expect(Number(tickTransactions[0]?.balanceBefore ?? 0)).toBe(
        preTickBalance
      );
    } else {
      expect(tickTransactions.length).toBe(0);
    }
  }, 120000);
});
