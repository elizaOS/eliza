/**
 * LLM-Powered Agent
 *
 * An agent that uses a real LLM (Groq, OpenAI, or Anthropic) to make decisions.
 * This is the primary agent for evaluating model quality in the Feed game context
 * and forms the foundation for OpenClaw, Hermes, and ElizaOS adapter comparisons.
 *
 * The agent receives a full context dump (balance, positions, markets, feed) and
 * uses the LLM to produce a structured action decision with reasoning.
 */

import type {
  A2AClientInterface,
  ActionResult,
  ActionType,
  AgentConfig,
  AgentContext,
  AgentDecision,
  TrainableAgent,
} from '../types';

// ─── Provider types ──────────────────────────────────────────────────────────

export type LLMProvider = 'groq' | 'openai' | 'anthropic';

export interface LLMAgentConfig {
  /** LLM provider to use */
  provider?: LLMProvider;
  /** Model name override (uses provider default if omitted) */
  model?: string;
  /** Temperature (0-2, default 0.7) */
  temperature?: number;
  /** API key override (reads from env if omitted) */
  apiKey?: string;
  /** System prompt suffix to append (for archetype-specific instructions) */
  systemSuffix?: string;
}

const PROVIDER_DEFAULTS: Record<
  LLMProvider,
  { model: string; baseURL: string; endpoint: string }
> = {
  groq: {
    model: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    endpoint: 'chat/completions',
  },
  openai: {
    model: 'gpt-4o-mini',
    baseURL: 'https://api.openai.com/v1',
    endpoint: 'chat/completions',
  },
  // Anthropic uses /messages with a different request and response shape
  anthropic: {
    model: 'claude-3-5-haiku-20241022',
    baseURL: 'https://api.anthropic.com/v1',
    endpoint: 'messages',
  },
};

// ─── Prompt templates ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous trading agent in Feed — a satirical prediction market game.

You observe the social feed, market conditions, and your portfolio, then decide what action to take.

Available actions and when to use them:
- BUY_YES / BUY_NO: Buy shares in a prediction market outcome (use when you have conviction)
- SELL_SHARES: Sell shares from an existing position (use to take profit or cut losses)
- CREATE_POST: Post content to the social feed (use to engage with the community)
- LIKE_POST: Like a post (quick social engagement)
- COMMENT_POST: Comment on a post with your own content
- VIEW_FEED: Observe feed without acting (use to gather intelligence)
- VIEW_MARKET_DATA: Study market conditions (use when assessing opportunities)
- HOLD: Do nothing this tick

Rules:
- Only trade markets that seem genuinely mispriced based on the feed signals
- Never risk more than 10% of balance on a single trade
- Write posts that fit the satirical, tech/finance-focused tone of Feed
- Provide clear reasoning for every decision

Respond with ONLY valid JSON, no other text:
{
  "action": "<ActionType>",
  "marketId": "<id or null>",
  "outcome": "<YES|NO|null>",
  "amount": <number or null>,
  "content": "<string for posts/comments or null>",
  "reasoning": "<one sentence explaining the decision>"
}`;

function buildUserPrompt(context: AgentContext): string {
  const { balance, positions, markets, posts, tick, archetype } = context;

  const archetypeNote = archetype
    ? `\nYour archetype: ${archetype.name} — ${archetype.description}\nTraits: greed=${archetype.traits.greed.toFixed(2)}, fear=${archetype.traits.fear.toFixed(2)}, confidence=${archetype.traits.confidence.toFixed(2)}, ethics=${archetype.traits.ethics.toFixed(2)}`
    : '';

  const portfolioSection = `PORTFOLIO (Tick ${tick}):
Balance: $${balance.toFixed(2)}
Positions: ${
    positions.length === 0
      ? 'None'
      : positions
          .map(
            (p) =>
              `  ${p.outcome} on market ${p.marketId.slice(-8)} — ${p.shares.toFixed(1)} shares @ $${p.avgPrice.toFixed(3)}`
          )
          .join('\n')
  }`;

  const marketsSection = `ACTIVE PREDICTION MARKETS (${markets.length} total):
${
  markets.length === 0
    ? 'None'
    : markets
        .slice(0, 8)
        .map(
          (m) =>
            `  [${m.id.slice(-8)}] ${m.question}\n    YES: $${m.yesPrice.toFixed(3)} | NO: $${m.noPrice.toFixed(3)}`
        )
        .join('\n')
}`;

  const feedSection = `RECENT FEED (${posts.length} posts):
${
  posts.length === 0
    ? 'Empty'
    : posts
        .slice(0, 5)
        .map((p) => `  @${p.authorName}: "${p.content.slice(0, 120)}"`)
        .join('\n')
}`;

  return `${archetypeNote}

${portfolioSection}

${marketsSection}

${feedSection}

Decide your next action. Remember to respond with ONLY valid JSON.`;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

interface LLMResponse {
  action: ActionType;
  marketId?: string | null;
  outcome?: 'YES' | 'NO' | null;
  amount?: number | null;
  content?: string | null;
  reasoning: string;
}

const VALID_ACTIONS = new Set<ActionType>([
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

function parseResponse(raw: string): LLMResponse {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Find the first { ... } block
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1)
    throw new Error('No JSON object found in LLM response');

  const json = JSON.parse(cleaned.slice(start, end + 1)) as Record<
    string,
    unknown
  >;
  const action = String(json.action ?? 'HOLD') as ActionType;

  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Invalid action from LLM: ${action}`);
  }

  return {
    action,
    marketId: (json.marketId as string | null) ?? null,
    outcome: (json.outcome as 'YES' | 'NO' | null) ?? null,
    amount: typeof json.amount === 'number' ? json.amount : null,
    content: typeof json.content === 'string' ? json.content : null,
    reasoning: String(json.reasoning ?? 'No reasoning provided'),
  };
}

// ─── HTTP completions helper ──────────────────────────────────────────────────

async function callLLM(
  provider: LLMProvider,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number
): Promise<string> {
  const { baseURL, endpoint } = PROVIDER_DEFAULTS[provider];

  // Anthropic uses /messages with a distinct request/response shape
  if (provider === 'anthropic') {
    const payload = {
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature,
      max_tokens: 300,
    };

    const resp = await fetch(`${baseURL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Anthropic API error ${resp.status}: ${body.slice(0, 200)}`
      );
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content.find((b) => b.type === 'text')?.text ?? '';
  }

  // OpenAI-compatible: Groq and OpenAI both use /chat/completions
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: 300,
  };

  const resp = await fetch(`${baseURL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── LLMAgent ─────────────────────────────────────────────────────────────────

export class LLMAgent implements TrainableAgent {
  readonly id = 'llm-agent';
  readonly name = 'LLM Agent';
  readonly language = 'typescript' as const;

  private llmConfig: LLMAgentConfig;
  private provider!: LLMProvider;
  private model!: string;
  private apiKey!: string;
  private systemPrompt!: string;
  private agentConfig?: AgentConfig;

  /** Number of consecutive LLM failures before falling back to HOLD */
  private failureCount = 0;
  private readonly maxFailures = 3;

  constructor(config: LLMAgentConfig = {}) {
    this.llmConfig = config;
  }

  async initialize(config: AgentConfig): Promise<void> {
    this.agentConfig = config;

    // Resolve provider: explicit config → GROQ_API_KEY → OPENAI_API_KEY → ANTHROPIC_API_KEY
    this.provider = this.llmConfig.provider ?? this.detectProvider();
    const defaults = PROVIDER_DEFAULTS[this.provider];
    this.model = this.llmConfig.model ?? defaults.model;
    this.apiKey = this.llmConfig.apiKey ?? this.resolveApiKey(this.provider);

    if (!this.apiKey) {
      throw new Error(
        `No API key found for provider "${this.provider}". ` +
          `Set GROQ_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY in your environment.`
      );
    }

    const archSuffix = config.archetype
      ? `\n\nYou are playing as: ${config.archetype.name}\n${config.archetype.system}`
      : '';
    const userSuffix = this.llmConfig.systemSuffix ?? '';
    this.systemPrompt = SYSTEM_PROMPT + archSuffix + userSuffix;

    console.log(
      `  [LLMAgent] Initialized: provider=${this.provider}, model=${this.model}, name=${config.name}`
    );
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    if (this.failureCount >= this.maxFailures) {
      return {
        action: 'HOLD',
        params: {},
        reasoning: 'LLM unavailable — holding',
      };
    }

    const userPrompt = buildUserPrompt(context);

    try {
      const raw = await callLLM(
        this.provider,
        this.model,
        this.apiKey,
        this.systemPrompt,
        userPrompt,
        this.llmConfig.temperature ?? 0.7
      );

      const parsed = parseResponse(raw);
      this.failureCount = 0;

      const params: Record<string, unknown> = {};
      if (parsed.marketId) params.marketId = parsed.marketId;
      if (parsed.outcome) params.outcome = parsed.outcome;
      if (parsed.amount != null) params.amount = parsed.amount;
      if (parsed.content) params.content = parsed.content;

      return {
        action: parsed.action,
        params,
        reasoning: parsed.reasoning,
      };
    } catch (err) {
      this.failureCount++;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [LLMAgent] Decision failed (${this.failureCount}/${this.maxFailures}): ${message}`
      );
      return {
        action: 'HOLD',
        params: {},
        reasoning: `LLM error: ${message}`,
      };
    }
  }

  /**
   * Custom executor that uses the LLM-provided marketId/outcome directly,
   * rather than the harness randomly picking from available markets.
   */
  async execute(
    decision: AgentDecision,
    client: A2AClientInterface
  ): Promise<ActionResult> {
    const { action, params } = decision;

    try {
      switch (action) {
        case 'BUY_YES':
        case 'BUY_NO': {
          const marketId = params.marketId as string | undefined;
          const outcome =
            (params.outcome as 'YES' | 'NO' | undefined) ??
            (action === 'BUY_YES' ? 'YES' : 'NO');

          // If LLM didn't specify a market, pick the one with the most extreme price
          let targetMarketId = marketId;
          if (!targetMarketId) {
            const { predictions } = await client.getMarkets();
            if (predictions.length === 0) {
              return { success: false, action, error: 'No markets available' };
            }
            const sorted = [...predictions].sort(
              (a, b) => Math.abs(a.yesPrice - 0.5) - Math.abs(b.yesPrice - 0.5)
            );
            targetMarketId = sorted[0].id;
          }

          const { balance } = await client.getBalance();
          const amount = Math.min(
            (params.amount as number | undefined) ?? balance * 0.05,
            balance * 0.1,
            balance - 1
          );

          if (amount < 1) {
            return { success: false, action, error: 'Insufficient balance' };
          }

          const trade = await client.buyShares(targetMarketId, outcome, amount);
          return {
            success: true,
            action,
            data: trade as unknown as Record<string, unknown>,
          };
        }

        case 'SELL_SHARES': {
          const { positions } = await client.getPositions();
          if (positions.length === 0) {
            return { success: false, action, error: 'No positions to sell' };
          }
          // Sell the position with the highest absolute PnL (take profit or cut loss)
          const target = positions.sort(
            (a, b) => Math.abs(b.pnl ?? 0) - Math.abs(a.pnl ?? 0)
          )[0];
          const trade = await client.sellShares(
            target.marketId,
            target.outcome,
            target.shares * 0.5
          );
          return {
            success: true,
            action,
            data: trade as unknown as Record<string, unknown>,
          };
        }

        case 'CREATE_POST': {
          const content =
            (params.content as string | undefined) ??
            'Interesting market conditions today.';
          const post = await client.createPost(content);
          return {
            success: true,
            action,
            data: post as unknown as Record<string, unknown>,
          };
        }

        case 'COMMENT_POST': {
          const content =
            (params.content as string | undefined) ??
            'Interesting perspective.';
          const { posts } = await client.getFeed(5);
          if (posts.length === 0)
            return { success: false, action, error: 'No posts to comment on' };
          const result = await client.commentPost(posts[0].id, content);
          return { success: true, action, data: result };
        }

        case 'LIKE_POST': {
          const { posts } = await client.getFeed(5);
          if (posts.length === 0)
            return { success: false, action, error: 'No posts to like' };
          const result = await client.likePost(posts[0].id);
          return { success: true, action, data: result };
        }

        default:
          return { success: true, action };
      }
    } catch (err) {
      return {
        success: false,
        action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async cleanup(): Promise<void> {
    // No persistent connections to close
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private detectProvider(): LLMProvider {
    if (process.env.GROQ_API_KEY) return 'groq';
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    // Default — will fail at initialize() with a clear message if key missing
    return 'groq';
  }

  private resolveApiKey(provider: LLMProvider): string {
    switch (provider) {
      case 'groq':
        return process.env.GROQ_API_KEY ?? '';
      case 'openai':
        return process.env.OPENAI_API_KEY ?? '';
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY ?? '';
    }
  }
}

/** Singleton factory — create one per harness run */
export function createLLMAgent(config: LLMAgentConfig = {}): LLMAgent {
  return new LLMAgent(config);
}
