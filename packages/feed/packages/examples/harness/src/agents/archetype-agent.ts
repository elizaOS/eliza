/**
 * Archetype-Influenced Agent
 *
 * An agent that makes decisions based on its assigned archetype configuration.
 * Demonstrates how to use archetype traits to influence behavior.
 */

import type {
  ActionType,
  AgentConfig,
  AgentContext,
  AgentDecision,
  ArchetypeConfig,
  TrainableAgent,
} from '../types';

export class ArchetypeAgent implements TrainableAgent {
  readonly id = 'archetype-agent';
  readonly name = 'Archetype Agent';
  readonly language = 'typescript' as const;

  private config?: AgentConfig;
  private archetype?: ArchetypeConfig;

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    this.archetype = config.archetype;
  }

  async decide(context: AgentContext): Promise<AgentDecision> {
    const archetype = this.archetype || context.archetype;

    if (!archetype) {
      // Fallback to random if no archetype
      return this.randomDecision(context);
    }

    // Use archetype weights to determine action category
    const weights = archetype.actionWeights;
    const roll = Math.random();

    let action: ActionType;
    const params: Record<string, unknown> = {};
    let reasoning: string;

    if (roll < weights.trade) {
      // Trading action
      action = this.decideTradeAction(context, archetype);
      reasoning = this.getTradeReasoning(action, archetype);
    } else if (roll < weights.trade + weights.post) {
      // Posting action
      action = 'CREATE_POST';
      params.content = this.generatePost(context, archetype);
      reasoning = `${archetype.name} sharing ${archetype.traits.ethics > 0.5 ? 'honest' : 'strategic'} insights`;
    } else if (roll < weights.trade + weights.post + weights.social) {
      // Social action
      action = this.decideSocialAction(context, archetype);
      reasoning = this.getSocialReasoning(action, archetype);
      if (action === 'COMMENT_POST') {
        params.content = this.generateComment(archetype);
      }
    } else {
      // Research/passive action
      action = this.decideResearchAction(context);
      reasoning = `${archetype.name} analyzing market conditions`;
    }

    // Apply archetype-specific adjustments
    if (context.balance < 50 && archetype.riskTolerance < 0.5) {
      // Conservative archetypes avoid trading with low balance
      if (action === 'BUY_YES' || action === 'BUY_NO') {
        action = 'VIEW_MARKET_DATA';
        reasoning = 'Conservative: preserving capital with low balance';
      }
    }

    if (
      context.positions.length > 0 &&
      archetype.traits.fear > 0.6 &&
      Math.random() < 0.3
    ) {
      // Fearful archetypes more likely to sell
      action = 'SELL_SHARES';
      reasoning = 'Risk management: reducing exposure';
    }

    return { action, params, reasoning };
  }

  private decideTradeAction(
    context: AgentContext,
    archetype: ArchetypeConfig
  ): ActionType {
    // If we have positions and are risk-averse, consider selling
    if (context.positions.length > 0) {
      const sellProbability = archetype.traits.fear * 0.5;
      if (Math.random() < sellProbability) {
        return 'SELL_SHARES';
      }
    }

    // If no markets or low balance, just view
    if (context.markets.length === 0 || context.balance < 10) {
      return 'VIEW_MARKET_DATA';
    }

    // Decide YES or NO based on traits
    // Confident, greedy archetypes favor YES (going with the crowd)
    // Contrarian archetypes (low confidence, high patience) favor NO
    const yesBias = (archetype.traits.confidence + archetype.traits.greed) / 2;
    return Math.random() < yesBias ? 'BUY_YES' : 'BUY_NO';
  }

  private getTradeReasoning(
    action: ActionType,
    archetype: ArchetypeConfig
  ): string {
    const name = archetype.name;
    switch (action) {
      case 'BUY_YES':
        return archetype.traits.confidence > 0.7
          ? `${name}: High conviction bullish bet`
          : `${name}: Following market momentum`;
      case 'BUY_NO':
        return archetype.traits.greed < 0.5
          ? `${name}: Contrarian position for value`
          : `${name}: Betting against the crowd`;
      case 'SELL_SHARES':
        return archetype.traits.fear > 0.5
          ? `${name}: Reducing risk exposure`
          : `${name}: Taking profits`;
      default:
        return `${name}: Observing market conditions`;
    }
  }

  private decideSocialAction(
    context: AgentContext,
    archetype: ArchetypeConfig
  ): ActionType {
    if (context.posts.length === 0) {
      return 'CREATE_POST';
    }

    // Social butterflies engage more
    if (
      archetype.id === 'social-butterfly' ||
      archetype.actionWeights.social > 0.3
    ) {
      return Math.random() < 0.5 ? 'LIKE_POST' : 'COMMENT_POST';
    }

    return Math.random() < 0.7 ? 'LIKE_POST' : 'COMMENT_POST';
  }

  private getSocialReasoning(
    action: ActionType,
    archetype: ArchetypeConfig
  ): string {
    const style = archetype.traits.ethics > 0.5 ? 'genuine' : 'strategic';
    switch (action) {
      case 'LIKE_POST':
        return `${archetype.name}: ${style} engagement`;
      case 'COMMENT_POST':
        return `${archetype.name}: Adding ${style} insight`;
      case 'DISCOVER_AGENTS':
        return `${archetype.name}: Expanding network`;
      default:
        return `${archetype.name}: Social activity`;
    }
  }

  private decideResearchAction(context: AgentContext): ActionType {
    const options: ActionType[] = [
      'VIEW_FEED',
      'VIEW_MARKET_DATA',
      'CHECK_LEADERBOARD',
      'DISCOVER_AGENTS',
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  private generatePost(
    context: AgentContext,
    archetype: ArchetypeConfig
  ): string {
    const templates = {
      ethical: [
        `Market analysis: ${context.markets.length} active markets to consider carefully.`,
        `Balance update: $${context.balance.toFixed(2)} - trading responsibly.`,
        `Sharing honest insights about current market conditions.`,
      ],
      manipulative: [
        `🚀 HUGE OPPORTUNITY incoming! Don't miss out!`,
        `This market is about to EXPLODE! Get in now!`,
        `Inside info: massive move expected soon...`,
      ],
      analytical: [
        `Technical analysis: Tracking ${context.positions.length} positions.`,
        `Market data suggests ${Math.random() > 0.5 ? 'bullish' : 'bearish'} sentiment.`,
        `Statistical edge identified in prediction markets.`,
      ],
      degen: [
        `YOLO! Going all in! 🎲`,
        `LFG! Diamond hands or nothing! 💎`,
        `Just aped into another position. No ragrets!`,
      ],
    };

    let category: keyof typeof templates;
    if (archetype.traits.ethics > 0.7) {
      category = 'ethical';
    } else if (archetype.traits.ethics < 0.3) {
      category = 'manipulative';
    } else if (archetype.traits.patience > 0.7) {
      category = 'analytical';
    } else if (archetype.riskTolerance > 0.8) {
      category = 'degen';
    } else {
      category = 'analytical';
    }

    const options = templates[category];
    return options[Math.floor(Math.random() * options.length)];
  }

  private generateComment(archetype: ArchetypeConfig): string {
    const templates = {
      helpful: [
        'Great analysis!',
        'Thanks for sharing!',
        'Helpful insight.',
        'I appreciate this perspective.',
      ],
      sycophantic: [
        'Amazing post! 🙌',
        "You're so smart!",
        "Best take I've seen!",
        'Following you now!',
      ],
      critical: [
        'Not sure about this...',
        'Have you considered the risks?',
        'Needs more data.',
        'Interesting but questionable.',
      ],
      chaotic: ['lol what', '🚀🚀🚀', 'wagmi', 'this is the way'],
    };

    let category: keyof typeof templates;
    if (archetype.id === 'ass-kisser') {
      category = 'sycophantic';
    } else if (archetype.traits.ethics > 0.7) {
      category = 'helpful';
    } else if (archetype.traits.patience > 0.7) {
      category = 'critical';
    } else {
      category = 'chaotic';
    }

    const options = templates[category];
    return options[Math.floor(Math.random() * options.length)];
  }

  private randomDecision(context: AgentContext): AgentDecision {
    const actions: ActionType[] = ['VIEW_FEED', 'VIEW_MARKET_DATA', 'HOLD'];
    if (context.markets.length > 0 && context.balance >= 10) {
      actions.push('BUY_YES', 'BUY_NO');
    }
    if (context.positions.length > 0) {
      actions.push('SELL_SHARES');
    }
    if (context.posts.length > 0) {
      actions.push('LIKE_POST');
    }

    const action = actions[Math.floor(Math.random() * actions.length)];
    return {
      action,
      params: {},
      reasoning: 'Random decision (no archetype configured)',
    };
  }

  async cleanup(): Promise<void> {
    // No cleanup needed
  }
}

// Export singleton
export const archetypeAgent = new ArchetypeAgent();
