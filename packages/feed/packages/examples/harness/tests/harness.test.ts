/**
 * Harness Tests
 *
 * Tests the agent training harness functionality.
 * Requires the local A2A server to be running on localhost:3001.
 */

import { describe, expect, test } from 'bun:test';
import { HarnessA2AClient } from '../src/a2a-client';
import { archetypeAgent } from '../src/agents/archetype-agent';
import { randomAgent } from '../src/agents/random-agent';
import {
  getAllArchetypes,
  getArchetype,
  getArchetypeIds,
} from '../src/archetypes';
import { runHarness } from '../src/harness';

const A2A_URL = 'http://localhost:3001';

// Top-level await: evaluated before test.skipIf() so the skip condition is correct
const serverAvailable = await (async () => {
  try {
    const r = await fetch(`${A2A_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
})();

if (!serverAvailable) {
  console.log(
    '⚠️  A2A server not running on :3001 — integration tests will be skipped'
  );
}

describe('Agent Harness', () => {
  describe('Archetypes', () => {
    test('should have all 12 archetypes', () => {
      const ids = getArchetypeIds();
      expect(ids.length).toBe(12);
    });

    test('should get archetype by ID', () => {
      const trader = getArchetype('trader');
      expect(trader.id).toBe('trader');
      expect(trader.name).toBe('Professional Trader');
      expect(trader.traits.patience).toBeGreaterThan(0.5);
    });

    test('should throw for unknown archetype', () => {
      expect(() => getArchetype('unknown')).toThrow();
    });

    test('all archetypes should have valid configs', () => {
      for (const archetype of getAllArchetypes()) {
        expect(archetype.id).toBeDefined();
        expect(archetype.name).toBeDefined();
        expect(archetype.description).toBeDefined();
        expect(archetype.system).toBeDefined();

        // Traits should be 0-1
        expect(archetype.traits.greed).toBeGreaterThanOrEqual(0);
        expect(archetype.traits.greed).toBeLessThanOrEqual(1);
        expect(archetype.traits.ethics).toBeGreaterThanOrEqual(0);
        expect(archetype.traits.ethics).toBeLessThanOrEqual(1);

        // Action weights should sum to ~1
        const weights = archetype.actionWeights;
        const sum =
          weights.trade + weights.post + weights.research + weights.social;
        expect(sum).toBeGreaterThan(0.9);
        expect(sum).toBeLessThan(1.1);
      }
    });
  });

  describe('A2A Client', () => {
    test('should create client with derived address', () => {
      const client = new HarnessA2AClient({
        baseUrl: A2A_URL,
        privateKey:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      });

      expect(client.getAddress()).toBe(
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
      );
      expect(client.getAgentId()).toMatch(/^agent-31337-\d+$/);
    });
  });

  describe('Agents', () => {
    test('random agent should have correct interface', () => {
      expect(randomAgent.id).toBe('random-agent');
      expect(randomAgent.name).toBe('Random Agent');
      expect(randomAgent.language).toBe('typescript');
      expect(typeof randomAgent.initialize).toBe('function');
      expect(typeof randomAgent.decide).toBe('function');
    });

    test('archetype agent should have correct interface', () => {
      expect(archetypeAgent.id).toBe('archetype-agent');
      expect(archetypeAgent.name).toBe('Archetype Agent');
      expect(archetypeAgent.language).toBe('typescript');
      expect(typeof archetypeAgent.initialize).toBe('function');
      expect(typeof archetypeAgent.decide).toBe('function');
    });

    test('random agent should make decisions', async () => {
      await randomAgent.initialize({
        a2aUrl: A2A_URL,
        privateKey:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      });

      const decision = await randomAgent.decide({
        balance: 1000,
        positions: [],
        markets: [
          {
            id: 'test',
            question: 'Test?',
            yesPrice: 0.5,
            noPrice: 0.5,
            status: 'open',
          },
        ],
        posts: [],
        tick: 1,
      });

      expect(decision.action).toBeDefined();
      expect(decision.reasoning).toBeDefined();
    });

    test('archetype agent should be influenced by archetype', async () => {
      const trader = getArchetype('trader');
      await archetypeAgent.initialize({
        a2aUrl: A2A_URL,
        privateKey:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        archetype: trader,
      });

      const decisions: string[] = [];
      for (let i = 0; i < 20; i++) {
        const decision = await archetypeAgent.decide({
          balance: 1000,
          positions: [],
          markets: [
            {
              id: 'test',
              question: 'Test?',
              yesPrice: 0.5,
              noPrice: 0.5,
              status: 'open',
            },
          ],
          posts: [
            {
              id: 'p1',
              content: 'test',
              authorId: 'u1',
              authorName: 'User',
              likesCount: 0,
              createdAt: '',
            },
          ],
          tick: i,
        });
        decisions.push(decision.action);
      }

      // Trader archetype should favor trading (70% weight)
      const tradeActions = decisions.filter(
        (a) =>
          a === 'BUY_YES' ||
          a === 'BUY_NO' ||
          a === 'SELL_SHARES' ||
          a === 'VIEW_MARKET_DATA'
      );
      expect(tradeActions.length).toBeGreaterThan(decisions.length * 0.3);
    });
  });

  describe('Harness Integration', () => {
    test.skipIf(!serverAvailable)(
      'should run harness with single agent',
      async () => {
        const result = await runHarness({
          a2aUrl: A2A_URL,
          agents: [randomAgent],
          archetypes: [getArchetype('trader')],
          instancesPerAgent: 1,
          ticksPerAgent: 3,
          parallelAgents: 1,
          tickInterval: 500,
          recordTrajectories: false,
        });

        expect(result.agentsRun).toBe(1);
        expect(result.totalTicks).toBe(3);
        expect(result.trajectories.length).toBe(1);
        expect(result.trajectories[0].steps.length).toBe(3);
      }
    );

    test.skipIf(!serverAvailable)(
      'should run harness with multiple archetypes',
      async () => {
        const result = await runHarness({
          a2aUrl: A2A_URL,
          agents: [archetypeAgent],
          archetypes: [getArchetype('trader'), getArchetype('degen')],
          instancesPerAgent: 1,
          ticksPerAgent: 3,
          parallelAgents: 2,
          tickInterval: 500,
          recordTrajectories: false,
        });

        expect(result.agentsRun).toBe(2); // 1 agent * 2 archetypes
        expect(result.trajectories.length).toBe(2);
        expect(result.stats.byArchetype['trader']).toBeDefined();
        expect(result.stats.byArchetype['degen']).toBeDefined();
      }
    );

    test.skipIf(!serverAvailable)(
      'should calculate rewards correctly',
      async () => {
        const result = await runHarness({
          a2aUrl: A2A_URL,
          agents: [randomAgent],
          archetypes: [getArchetype('trader')],
          instancesPerAgent: 1,
          ticksPerAgent: 5,
          parallelAgents: 1,
          tickInterval: 300,
          recordTrajectories: false,
        });

        const trajectory = result.trajectories[0];
        expect(trajectory.totalReward).toBeDefined();
        expect(typeof trajectory.totalReward).toBe('number');

        // Each step should have a reward
        for (const step of trajectory.steps) {
          expect(step.reward).toBeDefined();
        }
      }
    );
  });
});
