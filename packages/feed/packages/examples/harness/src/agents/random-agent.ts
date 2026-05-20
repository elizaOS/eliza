/**
 * Random Agent - Example implementation
 *
 * A simple agent that makes random decisions.
 * Use this as a template for creating your own agents.
 */

import type {
  ActionType,
  AgentConfig,
  AgentContext,
  AgentDecision,
  TrainableAgent,
} from '../types';

const ALL_ACTIONS: ActionType[] = [
  'BUY_YES',
  'BUY_NO',
  'SELL_SHARES',
  'CREATE_POST',
  'LIKE_POST',
  'COMMENT_POST',
  'VIEW_FEED',
  'DISCOVER_AGENTS',
  'SEARCH_USERS',
  'CHECK_LEADERBOARD',
  'CHECK_NOTIFICATIONS',
  'VIEW_MARKET_DATA',
  'HOLD',
];

const REASONINGS: Record<ActionType, string> = {
  BUY_YES: 'Market sentiment looks positive',
  BUY_NO: 'Feeling contrarian',
  SELL_SHARES: 'Taking profits',
  CREATE_POST: 'Sharing market insights',
  LIKE_POST: 'Engaging with community',
  COMMENT_POST: 'Adding to the discussion',
  VIEW_FEED: 'Checking latest chatter',
  DISCOVER_AGENTS: 'Looking for other agents',
  SEARCH_USERS: 'Finding interesting users',
  CHECK_LEADERBOARD: 'Checking rankings',
  CHECK_NOTIFICATIONS: 'Reviewing notifications',
  VIEW_MARKET_DATA: 'Analyzing market prices',
  HOLD: 'Waiting for opportunities',
};

export class RandomAgent implements TrainableAgent {
  readonly id = 'random-agent';
  readonly name = 'Random Agent';
  readonly language = 'typescript' as const;

  private config?: AgentConfig;

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    // Pick a random action
    let action = ALL_ACTIONS[Math.floor(Math.random() * ALL_ACTIONS.length)];

    // Apply some basic intelligence
    if (action === 'SELL_SHARES' && context.positions.length === 0) {
      action = 'VIEW_MARKET_DATA';
    }
    if ((action === 'BUY_YES' || action === 'BUY_NO') && context.balance < 10) {
      action = 'VIEW_FEED';
    }
    if (
      (action === 'LIKE_POST' || action === 'COMMENT_POST') &&
      context.posts.length === 0
    ) {
      action = 'CREATE_POST';
    }

    // Generate content for social actions
    const params: Record<string, unknown> = {};
    if (action === 'CREATE_POST') {
      const templates = [
        `Tick ${context.tick}: Analyzing market conditions 📊`,
        `Balance: $${context.balance.toFixed(2)} | Positions: ${context.positions.length}`,
        `Random agent reporting! Markets are ${Math.random() > 0.5 ? 'bullish' : 'bearish'} today.`,
        `Just another day in the prediction markets! 🎲`,
      ];
      params.content = templates[Math.floor(Math.random() * templates.length)];
    }
    if (action === 'COMMENT_POST') {
      const comments = [
        'Interesting point!',
        'I agree with this analysis.',
        'Good insight! 👍',
        'Thanks for sharing.',
      ];
      params.content = comments[Math.floor(Math.random() * comments.length)];
    }

    return {
      action,
      params,
      reasoning: REASONINGS[action],
    };
  }

  async cleanup(): Promise<void> {
    // No cleanup needed
  }
}

// Export singleton for easy use
export const randomAgent = new RandomAgent();
