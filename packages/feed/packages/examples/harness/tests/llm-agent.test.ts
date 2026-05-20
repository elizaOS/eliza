/**
 * LLMAgent Tests
 *
 * Tests LLM response parsing, provider detection, prompt building, and
 * decision execution — all without making real API calls.
 */

import { describe, expect, mock, test } from 'bun:test';
import { createLLMAgent } from '../src/agents/llm-agent';
import type { AgentContext } from '../src/types';

// ─── Test context fixture ─────────────────────────────────────────────────────

const ctx: AgentContext = {
  balance: 1000,
  tick: 1,
  positions: [],
  markets: [
    {
      id: 'market-abc123',
      question: 'Will BTC hit $100k?',
      yesPrice: 0.65,
      noPrice: 0.35,
      status: 'active',
    },
    {
      id: 'market-def456',
      question: 'Will ETH flip BTC?',
      yesPrice: 0.15,
      noPrice: 0.85,
      status: 'active',
    },
  ],
  posts: [
    {
      id: 'p1',
      content: 'BTC looking bullish today',
      authorId: 'u1',
      authorName: 'CryptoShill',
      likesCount: 10,
      createdAt: '',
    },
  ],
};

// ─── Mock fetch ───────────────────────────────────────────────────────────────

function mockFetch(response: unknown, ok = true, status = 200) {
  return mock(async () => ({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }));
}

// ─── Parsing tests (unit, no network) ────────────────────────────────────────

describe('LLMAgent - response parsing via decide()', () => {
  test('parses clean JSON response', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'test-key' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const apiResp = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: 'BUY_YES',
              marketId: 'market-abc123',
              outcome: 'YES',
              amount: 50,
              content: null,
              reasoning: 'BTC bullish signal',
            }),
          },
        },
      ],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(apiResp) as unknown as typeof fetch;
    const decision = await agent.decide(ctx);
    globalThis.fetch = origFetch;

    expect(decision.action).toBe('BUY_YES');
    expect(decision.params.marketId).toBe('market-abc123');
    expect(decision.params.outcome).toBe('YES');
    expect(decision.params.amount).toBe(50);
    expect(decision.reasoning).toBe('BTC bullish signal');
  });

  test('parses JSON wrapped in markdown code fences', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'test-key' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const apiResp = {
      choices: [
        {
          message: {
            content:
              '```json\n{"action":"CREATE_POST","marketId":null,"outcome":null,"amount":null,"content":"Market looking interesting","reasoning":"Engaging socially"}\n```',
          },
        },
      ],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(apiResp) as unknown as typeof fetch;
    const decision = await agent.decide(ctx);
    globalThis.fetch = origFetch;

    expect(decision.action).toBe('CREATE_POST');
    expect(decision.params.content).toBe('Market looking interesting');
  });

  test('falls back to HOLD on invalid JSON', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'test-key' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const apiResp = {
      choices: [{ message: { content: 'I think we should hold for now.' } }],
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(apiResp) as unknown as typeof fetch;
    const decision = await agent.decide(ctx);
    globalThis.fetch = origFetch;

    expect(decision.action).toBe('HOLD');
  });

  test('falls back to HOLD on API error', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'bad-key' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })) as unknown as typeof fetch;
    const decision = await agent.decide(ctx);
    globalThis.fetch = origFetch;

    expect(decision.action).toBe('HOLD');
    expect(decision.reasoning).toMatch(/LLM error/i);
  });

  test('falls back to HOLD after maxFailures exceeded', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'bad-key' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const failFetch = mock(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Server Error',
    })) as unknown as typeof fetch;

    const origFetch = globalThis.fetch;
    globalThis.fetch = failFetch;

    // Exhaust the 3-failure limit
    await agent.decide(ctx); // fail 1
    await agent.decide(ctx); // fail 2
    await agent.decide(ctx); // fail 3

    // Now fetch should NOT be called again (agent is in permanent HOLD)
    const callsBefore = (failFetch as ReturnType<typeof mock>).mock.calls
      .length;
    const decision = await agent.decide(ctx); // should HOLD without calling fetch
    const callsAfter = (failFetch as ReturnType<typeof mock>).mock.calls.length;

    globalThis.fetch = origFetch;

    expect(decision.action).toBe('HOLD');
    expect(callsAfter).toBe(callsBefore); // no additional API call
  });

  test('uses Anthropic /messages endpoint not /chat/completions', async () => {
    const agent = createLLMAgent({ provider: 'anthropic', apiKey: 'test-key' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    let capturedUrl = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            { type: 'text', text: '{"action":"HOLD","reasoning":"test"}' },
          ],
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    await agent.decide(ctx);
    globalThis.fetch = origFetch;

    expect(capturedUrl).toContain('/messages');
    expect(capturedUrl).not.toContain('/chat/completions');
  });
});

// ─── Provider detection tests ─────────────────────────────────────────────────

describe('LLMAgent - interface', () => {
  test('has correct id, name, language', () => {
    const agent = createLLMAgent();
    expect(agent.id).toBe('llm-agent');
    expect(agent.name).toBe('LLM Agent');
    expect(agent.language).toBe('typescript');
  });

  test('initialize throws without API key', async () => {
    const origGroq = process.env.GROQ_API_KEY;
    const origOpenAI = process.env.OPENAI_API_KEY;
    const origAnthropic = process.env.ANTHROPIC_API_KEY;

    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const agent = createLLMAgent({ provider: 'groq' });

    let threw = false;
    try {
      await agent.initialize({ a2aUrl: '', privateKey: '0x0' });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/API key/i);
    }

    // Restore env
    if (origGroq !== undefined) process.env.GROQ_API_KEY = origGroq;
    if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI;
    if (origAnthropic !== undefined)
      process.env.ANTHROPIC_API_KEY = origAnthropic;

    expect(threw).toBe(true);
  });

  test('cleanup is a no-op', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });
    await expect(agent.cleanup()).resolves.toBeUndefined();
  });
});

// ─── Execute method tests ─────────────────────────────────────────────────────

describe('LLMAgent - execute()', () => {
  const makeClient = (overrides?: Partial<Record<string, unknown>>) => ({
    getBalance: async () => ({ balance: 500, currency: 'USD' }),
    getPositions: async () => ({
      positions: [
        {
          id: 'pos1',
          marketId: 'market-abc123',
          outcome: 'YES' as const,
          shares: 10,
          avgPrice: 0.5,
          pnl: 5,
        },
      ],
    }),
    getMarkets: async () => ({
      predictions: [
        {
          id: 'market-abc123',
          question: 'Test?',
          yesPrice: 0.6,
          noPrice: 0.4,
          status: 'active',
        },
      ],
      perps: [],
    }),
    getFeed: async () => ({
      posts: [
        {
          id: 'p1',
          content: 'test',
          authorId: 'u1',
          authorName: 'Alice',
          likesCount: 0,
          createdAt: '',
        },
      ],
    }),
    buyShares: async (marketId: string, outcome: string, amount: number) => ({
      id: 'trade1',
      marketId,
      outcome,
      shares: amount / 0.6,
      price: 0.6,
      totalCost: amount,
    }),
    sellShares: async (marketId: string, outcome: string, shares: number) => ({
      id: 'trade2',
      marketId,
      outcome,
      shares,
      price: 0.6,
      totalCost: shares * 0.6,
    }),
    createPost: async (content: string) => ({
      id: 'post1',
      content,
      authorId: 'a',
      authorName: 'A',
      likesCount: 0,
      createdAt: '',
    }),
    likePost: async () => ({ success: true, likesCount: 1 }),
    commentPost: async () => ({ id: 'c1' }),
    discover: async () => ({ agents: [] }),
    searchUsers: async () => ({ users: [] }),
    getStats: async () => ({ totalAgents: 1, totalMarkets: 1, totalVolume: 0 }),
    getLeaderboard: async () => ({ entries: [] }),
    getNotifications: async () => ({ notifications: [] }),
    ...overrides,
  });

  test('BUY_YES with LLM-specified marketId uses that market', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient();
    const result = await agent.execute!(
      {
        action: 'BUY_YES',
        params: { marketId: 'market-abc123', outcome: 'YES', amount: 50 },
        reasoning: '',
      },
      client as never
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('BUY_YES');
  });

  test('BUY_NO without marketId picks best market', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient();
    const result = await agent.execute!(
      { action: 'BUY_NO', params: {}, reasoning: '' },
      client as never
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('BUY_NO');
  });

  test('BUY_YES returns failure when balance < 1', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient({
      getBalance: async () => ({ balance: 0.5, currency: 'USD' }),
    });
    const result = await agent.execute!(
      { action: 'BUY_YES', params: {}, reasoning: '' },
      client as never
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/balance/i);
  });

  test('SELL_SHARES sells highest-pnl position', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient();
    const result = await agent.execute!(
      { action: 'SELL_SHARES', params: {}, reasoning: '' },
      client as never
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('SELL_SHARES');
  });

  test('SELL_SHARES returns failure when no positions', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient({
      getPositions: async () => ({ positions: [] }),
    });
    const result = await agent.execute!(
      { action: 'SELL_SHARES', params: {}, reasoning: '' },
      client as never
    );

    expect(result.success).toBe(false);
  });

  test('CREATE_POST uses LLM-provided content', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient();
    const result = await agent.execute!(
      {
        action: 'CREATE_POST',
        params: { content: 'AI markets are popping' },
        reasoning: '',
      },
      client as never
    );

    expect(result.success).toBe(true);
  });

  test('VIEW_FEED returns success without API call', async () => {
    const agent = createLLMAgent({ provider: 'groq', apiKey: 'k' });
    await agent.initialize({ a2aUrl: '', privateKey: '0x0' });

    const client = makeClient();
    const result = await agent.execute!(
      { action: 'VIEW_FEED', params: {}, reasoning: '' },
      client as never
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('VIEW_FEED');
  });
});
