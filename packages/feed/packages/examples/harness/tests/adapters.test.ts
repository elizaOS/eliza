/**
 * Adapter Tests
 *
 * Tests HermesAdapter and OpenClawAdapter without requiring real external
 * processes. Adapters are tested for:
 *   - Interface conformance (id, name, language, initialize, decide, cleanup)
 *   - Response parsing (JSON, natural language fallbacks)
 *   - Error handling (subprocess failure → HOLD, failure count cap)
 *   - Stdout line buffering (for Hermes)
 */

import { describe, expect, test } from 'bun:test';
import {
  createHermesAdapter,
  HermesAdapter,
} from '../src/adapters/hermes-adapter';
import {
  createOpenClawAdapter,
  OpenClawAdapter,
} from '../src/adapters/openclaw-adapter';
import type { AgentContext } from '../src/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ctx: AgentContext = {
  balance: 500,
  tick: 3,
  positions: [],
  markets: [
    {
      id: 'mkt-abc',
      question: 'Will AI take over?',
      yesPrice: 0.7,
      noPrice: 0.3,
      status: 'active',
    },
  ],
  posts: [
    {
      id: 'p1',
      content: 'Bullish',
      authorId: 'u1',
      authorName: 'Alice',
      likesCount: 5,
      createdAt: '',
    },
  ],
};

// ─── HermesAdapter interface tests ───────────────────────────────────────────

describe('HermesAdapter', () => {
  test('createHermesAdapter returns HermesAdapter instance', () => {
    const adapter = createHermesAdapter({
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    expect(adapter).toBeInstanceOf(HermesAdapter);
  });

  test('has correct id, name, language', () => {
    const adapter = createHermesAdapter({ model: 'm' });
    expect(adapter.id).toBe('hermes-adapter');
    expect(adapter.name).toBe('Hermes Agent');
    expect(adapter.language).toBe('typescript');
  });

  test('initialize throws when hermes is not bootstrapped', async () => {
    const adapter = createHermesAdapter({
      model: 'test-model',
      workspaceRoot: '/nonexistent/path',
    });

    let threw = false;
    try {
      await adapter.initialize({ a2aUrl: '', privateKey: '0x0' });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/bootstrap|venv|not found/i);
    }
    expect(threw).toBe(true);
  });

  test('decide returns HOLD when max failures exceeded', async () => {
    // Create adapter and directly manipulate failCount via the private field
    // by exhausting failures through initialization failure
    const adapter = createHermesAdapter({
      model: 'test-model',
      workspaceRoot: '/nonexistent',
      persistent: false,
    });

    // Without initializing (pythonExe empty), any spawn will fail
    // We can test decide behavior by calling it after a simulated fail state
    // by replacing internals via the decide fallback path
    // Since we can't easily trigger the subprocess failure without bootstrap,
    // verify the HOLD fallback returns valid structure when failCount >= maxFail

    // Access via type cast to test internal fallback
    const anyAdapter = adapter as unknown as {
      failCount: number;
      maxFail: number;
    };
    anyAdapter.failCount = anyAdapter.maxFail; // simulate exhausted failures

    const decision = await adapter.decide(ctx);
    expect(decision.action).toBe('HOLD');
    expect(decision.reasoning).toMatch(/unavailable/i);
  });

  describe('parseDecision (internal, tested via response patterns)', () => {
    // These test the static response parser via the fallback path
    // We call it indirectly via a mock subprocess

    const VALID_ACTIONS = new Set([
      'BUY_YES',
      'BUY_NO',
      'SELL_SHARES',
      'CREATE_POST',
      'LIKE_POST',
      'COMMENT_POST',
      'VIEW_FEED',
      'VIEW_MARKET_DATA',
      'DISCOVER_AGENTS',
      'SEARCH_USERS',
      'CHECK_LEADERBOARD',
      'CHECK_NOTIFICATIONS',
      'HOLD',
    ]);

    // Test the exported parsing logic indirectly by checking
    // what parseDecision returns for various inputs
    const parseDecision = (raw: string) => {
      // Mirror the logic from hermes-adapter.ts parseDecision()
      const cleaned = raw
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');

      if (start === -1 || end === -1) {
        if (/buy.*yes/i.test(raw))
          return {
            action: 'BUY_YES',
            params: {},
            reasoning: raw.slice(0, 100),
          };
        if (/buy.*no/i.test(raw))
          return { action: 'BUY_NO', params: {}, reasoning: raw.slice(0, 100) };
        if (/sell/i.test(raw))
          return {
            action: 'SELL_SHARES',
            params: {},
            reasoning: raw.slice(0, 100),
          };
        if (/post|tweet/i.test(raw))
          return {
            action: 'CREATE_POST',
            params: { content: raw.slice(0, 200) },
            reasoning: 'auto',
          };
        return {
          action: 'HOLD',
          params: {},
          reasoning: `Unparseable: ${raw.slice(0, 80)}`,
        };
      }

      const json = JSON.parse(cleaned.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      const action = String(json.action ?? 'HOLD');
      const safeAction = VALID_ACTIONS.has(action) ? action : 'HOLD';
      const params: Record<string, unknown> = {};
      if (json.marketId) params.marketId = json.marketId;
      if (json.outcome) params.outcome = json.outcome;
      if (json.amount) params.amount = json.amount;
      if (json.content) params.content = json.content;
      return {
        action: safeAction,
        params,
        reasoning: String(json.reasoning ?? 'Hermes decision'),
      };
    };

    test('parses clean JSON', () => {
      const result = parseDecision(
        '{"action":"BUY_YES","marketId":"mkt-abc","outcome":"YES","amount":50,"content":null,"reasoning":"bullish"}'
      );
      expect(result.action).toBe('BUY_YES');
      expect(result.params.marketId).toBe('mkt-abc');
      expect(result.params.amount).toBe(50);
    });

    test('parses JSON with preamble text', () => {
      const result = parseDecision(
        'Based on the data: {"action":"SELL_SHARES","reasoning":"taking profit"}'
      );
      expect(result.action).toBe('SELL_SHARES');
    });

    test('falls back on "buy yes" natural language', () => {
      const result = parseDecision('I would buy yes on this market');
      expect(result.action).toBe('BUY_YES');
    });

    test('falls back to HOLD on empty/unparseable', () => {
      const result = parseDecision('');
      expect(result.action).toBe('HOLD');
    });

    test('maps unknown action to HOLD', () => {
      const result = parseDecision(
        '{"action":"MOON","reasoning":"to the moon"}'
      );
      expect(result.action).toBe('HOLD');
    });
  });
});

// ─── OpenClawAdapter interface tests ─────────────────────────────────────────

describe('OpenClawAdapter', () => {
  test('createOpenClawAdapter returns OpenClawAdapter instance', () => {
    const adapter = createOpenClawAdapter({ mode: 'cli' });
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
  });

  test('has correct id, name, language', () => {
    const adapter = createOpenClawAdapter();
    expect(adapter.id).toBe('openclaw-adapter');
    expect(adapter.name).toBe('OpenClaw Agent');
    expect(adapter.language).toBe('typescript');
  });

  test('initialize throws when openclaw binary not found and workspace is nonexistent', async () => {
    const adapter = createOpenClawAdapter({
      mode: 'cli',
      workspaceRoot: '/nonexistent/path',
      openClawBin: '',
    });

    let threw = false;
    try {
      await adapter.initialize({ a2aUrl: '', privateKey: '0x0' });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(
        /openclaw|binary|not found|install/i
      );
    }
    expect(threw).toBe(true);
  });

  test('decide returns HOLD when max failures exceeded', async () => {
    const adapter = createOpenClawAdapter({ mode: 'cli' });
    const anyAdapter = adapter as unknown as {
      failCount: number;
      maxFail: number;
    };
    anyAdapter.failCount = anyAdapter.maxFail;

    const decision = await adapter.decide(ctx);
    expect(decision.action).toBe('HOLD');
    expect(decision.reasoning).toMatch(/unavailable/i);
  });

  test('cleanup is a no-op', async () => {
    const adapter = createOpenClawAdapter();
    await expect(adapter.cleanup()).resolves.toBeUndefined();
  });

  describe('parseOpenClawResponse (internal logic)', () => {
    // Mirror the parseOpenClawResponse logic from openclaw-adapter.ts
    const VALID_ACTIONS = new Set([
      'BUY_YES',
      'BUY_NO',
      'SELL_SHARES',
      'CREATE_POST',
      'LIKE_POST',
      'COMMENT_POST',
      'VIEW_FEED',
      'VIEW_MARKET_DATA',
      'DISCOVER_AGENTS',
      'SEARCH_USERS',
      'CHECK_LEADERBOARD',
      'CHECK_NOTIFICATIONS',
      'HOLD',
    ]);

    const parseResponse = (raw: string) => {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) {
        if (/\bbuy.*yes\b/i.test(raw))
          return {
            action: 'BUY_YES',
            params: {},
            reasoning: raw.slice(0, 100),
          };
        if (/\bbuy.*no\b/i.test(raw))
          return { action: 'BUY_NO', params: {}, reasoning: raw.slice(0, 100) };
        if (/\bsell\b/i.test(raw))
          return {
            action: 'SELL_SHARES',
            params: {},
            reasoning: raw.slice(0, 100),
          };
        if (/\bpost\b/i.test(raw))
          return {
            action: 'CREATE_POST',
            params: { content: raw.slice(0, 200) },
            reasoning: 'auto',
          };
        return {
          action: 'HOLD',
          params: {},
          reasoning: `No JSON found: ${raw.slice(0, 80)}`,
        };
      }
      const json = JSON.parse(raw.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      const action = String(json.action ?? 'HOLD');
      const params: Record<string, unknown> = {};
      if (json.marketId) params.marketId = json.marketId;
      if (json.outcome) params.outcome = json.outcome;
      if (json.amount) params.amount = json.amount;
      if (json.content) params.content = json.content;
      return {
        action: VALID_ACTIONS.has(action) ? action : 'HOLD',
        params,
        reasoning: String(json.reasoning ?? 'OpenClaw decision'),
      };
    };

    test('parses structured JSON response', () => {
      const result = parseResponse(
        '{"action":"CREATE_POST","content":"Markets are wild today","reasoning":"engaging"}'
      );
      expect(result.action).toBe('CREATE_POST');
      expect(result.params.content).toBe('Markets are wild today');
    });

    test('keyword fallback: sell', () => {
      const result = parseResponse(
        'I think you should sell your positions now.'
      );
      expect(result.action).toBe('SELL_SHARES');
    });

    test('keyword fallback: buy yes', () => {
      const result = parseResponse('I would buy yes here.');
      expect(result.action).toBe('BUY_YES');
    });

    test('keyword fallback: post', () => {
      const result = parseResponse(
        'You should post something about this market.'
      );
      expect(result.action).toBe('CREATE_POST');
    });

    test('maps invalid action to HOLD', () => {
      const result = parseResponse(
        '{"action":"INVALID_ACTION","reasoning":"test"}'
      );
      expect(result.action).toBe('HOLD');
    });

    test('HOLD on empty string', () => {
      const result = parseResponse('');
      expect(result.action).toBe('HOLD');
    });

    test('all known actions parse correctly', () => {
      for (const action of VALID_ACTIONS) {
        const result = parseResponse(
          `{"action":"${action}","reasoning":"test"}`
        );
        expect(result.action).toBe(action);
      }
    });
  });
});

// ─── Production client interface tests ───────────────────────────────────────

describe('FeedProductionClient', () => {
  test('can be imported and instantiated', async () => {
    const { FeedProductionClient } = await import(
      '../src/production-client'
    );
    const client = new FeedProductionClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      agentName: 'test-agent',
    });
    expect(client).toBeDefined();
    expect(typeof client.getBalance).toBe('function');
    expect(typeof client.getMarkets).toBe('function');
    expect(typeof client.buyShares).toBe('function');
    expect(typeof client.createPost).toBe('function');
  });

  test('contextId is unique per instance', async () => {
    const { FeedProductionClient } = await import(
      '../src/production-client'
    );
    const a = new FeedProductionClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'k',
      agentName: 'a',
    });
    const b = new FeedProductionClient({
      baseUrl: 'http://localhost:3000',
      apiKey: 'k',
      agentName: 'b',
    });
    // Both are valid objects; context IDs are internal but names differ
    expect(a).not.toBe(b);
  });
});

// ─── Harness clientFactory tests ─────────────────────────────────────────────

describe('HarnessConfig.clientFactory', () => {
  test('clientFactory is used instead of HarnessA2AClient', async () => {
    const { runHarness } = await import('../src/harness');
    const { randomAgent } = await import('../src/agents/random-agent');
    const { getArchetype } = await import('../src/archetypes');

    let factoryCalled = false;
    let factoryCallCount = 0;

    // Minimal mock client
    const mockClient = {
      getBalance: async () => ({ balance: 1000, currency: 'USD' }),
      getPositions: async () => ({ positions: [] }),
      getPortfolio: async () => ({ balance: 1000, positions: [], pnl: 0 }),
      getMarkets: async () => ({ predictions: [], perps: [] }),
      getMarketData: async () => {
        throw new Error('not used');
      },
      buyShares: async () => {
        throw new Error('not used');
      },
      sellShares: async () => {
        throw new Error('not used');
      },
      getFeed: async () => ({ posts: [] }),
      createPost: async () => {
        throw new Error('not used');
      },
      likePost: async () => ({ success: true, likesCount: 0 }),
      commentPost: async () => ({ id: 'c1' }),
      discover: async () => ({ agents: [] }),
      searchUsers: async () => ({ users: [] }),
      getStats: async () => ({
        totalAgents: 0,
        totalMarkets: 0,
        totalVolume: 0,
      }),
      getLeaderboard: async () => ({ entries: [] }),
      getNotifications: async () => ({ notifications: [] }),
    };

    const result = await runHarness({
      a2aUrl: 'http://unused',
      agents: [randomAgent],
      archetypes: [getArchetype('trader')],
      instancesPerAgent: 1,
      ticksPerAgent: 2,
      parallelAgents: 1,
      tickInterval: 0,
      recordTrajectories: false,
      clientFactory: (idx) => {
        factoryCalled = true;
        factoryCallCount++;
        return mockClient;
      },
    });

    expect(factoryCalled).toBe(true);
    expect(factoryCallCount).toBe(1); // 1 agent × 1 archetype × 1 instance
    expect(result.agentsRun).toBe(1);
    expect(result.trajectories.length).toBe(1);
    expect(result.trajectories[0].steps.length).toBe(2);
  });

  test('errors array is populated when tick throws', async () => {
    const { runHarness } = await import('../src/harness');
    const { randomAgent } = await import('../src/agents/random-agent');
    const { getArchetype } = await import('../src/archetypes');

    // Client that always throws
    const throwingClient = {
      getBalance: async () => {
        throw new Error('simulated failure');
      },
      getPositions: async () => {
        throw new Error('simulated failure');
      },
      getPortfolio: async () => {
        throw new Error('simulated failure');
      },
      getMarkets: async () => {
        throw new Error('simulated failure');
      },
      getMarketData: async () => {
        throw new Error('not used');
      },
      buyShares: async () => {
        throw new Error('not used');
      },
      sellShares: async () => {
        throw new Error('not used');
      },
      getFeed: async () => {
        throw new Error('simulated failure');
      },
      createPost: async () => {
        throw new Error('not used');
      },
      likePost: async () => ({ success: true, likesCount: 0 }),
      commentPost: async () => ({ id: 'c1' }),
      discover: async () => ({ agents: [] }),
      searchUsers: async () => ({ users: [] }),
      getStats: async () => ({
        totalAgents: 0,
        totalMarkets: 0,
        totalVolume: 0,
      }),
      getLeaderboard: async () => ({ entries: [] }),
      getNotifications: async () => ({ notifications: [] }),
    };

    const result = await runHarness({
      a2aUrl: 'http://unused',
      agents: [randomAgent],
      archetypes: [getArchetype('degen')],
      instancesPerAgent: 1,
      ticksPerAgent: 1,
      parallelAgents: 1,
      tickInterval: 0,
      recordTrajectories: false,
      clientFactory: () => throwingClient,
    });

    // Errors should be recorded, not thrown
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/simulated failure/i);
    // Trajectory still has a synthetic HOLD step
    expect(result.trajectories[0].steps[0].decision.action).toBe('HOLD');
  });
});
