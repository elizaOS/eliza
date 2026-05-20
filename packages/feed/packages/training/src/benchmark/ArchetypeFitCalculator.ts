/**
 * Archetype Fit Calculator
 *
 * Measures how well an agent's behavior aligns with its declared archetype.
 * Uses observable action distributions and trading patterns to quantify fit.
 *
 * Each archetype has expected behavioral patterns defined in ArchetypeConfigService.
 * This calculator compares actual behavior against those expectations.
 */

import type {
  ArchetypeActionWeights,
  ArchetypeConfig,
} from '../archetypes/ArchetypeConfigService';
import { ArchetypeConfigService } from '../archetypes/ArchetypeConfigService';
import type { AgentAction, SimulationResult } from './SimulationEngine';

// ============================================================================
// Types
// ============================================================================

export interface ActionDistribution {
  trade: number;
  post: number;
  research: number;
  social: number;
  other: number;
}

export interface TradingBehaviorMetrics {
  /** Total number of trades */
  tradeCount: number;
  /** Average position size relative to starting balance */
  avgPositionSizeRatio: number;
  /** Maximum leverage used */
  maxLeverageUsed: number;
  /** Ratio of long to short positions */
  longShortRatio: number;
  /** P&L variance (volatility of returns) */
  pnlVariance: number;
  /** Win rate (profitable trades / total trades) */
  winRate: number;
  /** Average hold time in ticks */
  avgHoldTime: number;
  /** Number of distinct markets traded */
  marketDiversification: number;
}

export interface SocialBehaviorMetrics {
  /** Number of posts created */
  postsCreated: number;
  /** Number of groups joined */
  groupsJoined: number;
  /** Number of DMs sent */
  dmsSent: number;
  /** Average post frequency (posts per day) */
  postFrequency: number;
  /** Estimated engagement style based on content patterns */
  engagementStyle:
    | 'helpful'
    | 'misleading'
    | 'analytical'
    | 'promotional'
    | 'unknown';
}

export interface ArchetypeFitScore {
  /** The archetype being evaluated */
  archetype: string;
  /** Overall fit score (0-1) */
  fitScore: number;
  /** Component scores */
  components: {
    /** How well action distribution matches archetype config (0-1) */
    actionDistribution: number;
    /** How well trading behavior matches archetype traits (0-1) */
    riskBehavior: number;
    /** How well social behavior matches archetype config (0-1) */
    socialBehavior: number;
    /** Activity level appropriateness (0-1) */
    activityLevel: number;
  };
  /** Detailed metrics */
  metrics: {
    actionDistribution: ActionDistribution;
    tradingBehavior: TradingBehaviorMetrics;
    socialBehavior: SocialBehaviorMetrics;
  };
  /** Specific observations about fit/misfit */
  observations: string[];
}

// ============================================================================
// Action Classification
// ============================================================================

type ActionCategory = 'trade' | 'post' | 'research' | 'social' | 'other';

function classifyAction(actionType: string): ActionCategory {
  const normalizedType = actionType.toLowerCase();

  // Trading actions
  if (
    normalizedType.includes('buy') ||
    normalizedType.includes('sell') ||
    normalizedType.includes('open') ||
    normalizedType.includes('close') ||
    normalizedType.includes('trade') ||
    normalizedType.includes('perp') ||
    normalizedType.includes('prediction')
  ) {
    return 'trade';
  }

  // Posting actions
  if (
    normalizedType.includes('post') ||
    normalizedType.includes('tweet') ||
    normalizedType.includes('publish') ||
    normalizedType.includes('comment')
  ) {
    return 'post';
  }

  // Research actions
  if (
    normalizedType.includes('research') ||
    normalizedType.includes('analyze') ||
    normalizedType.includes('query') ||
    normalizedType.includes('read') ||
    normalizedType.includes('investigate')
  ) {
    return 'research';
  }

  // Social actions
  if (
    normalizedType.includes('join') ||
    normalizedType.includes('dm') ||
    normalizedType.includes('message') ||
    normalizedType.includes('invite') ||
    normalizedType.includes('follow') ||
    normalizedType.includes('engage')
  ) {
    return 'social';
  }

  return 'other';
}

function calculateActionDistribution(
  actions: AgentAction[] | undefined | null
): ActionDistribution {
  // Handle undefined/null actions defensively
  if (!actions || !Array.isArray(actions)) {
    return { trade: 0, post: 0, research: 0, social: 0, other: 0 };
  }

  const counts = { trade: 0, post: 0, research: 0, social: 0, other: 0 };

  for (const action of actions) {
    const category = classifyAction(action.type);
    counts[category]++;
  }

  const total = actions.length || 1; // Avoid division by zero

  return {
    trade: counts.trade / total,
    post: counts.post / total,
    research: counts.research / total,
    social: counts.social / total,
    other: counts.other / total,
  };
}

// ============================================================================
// Trading Behavior Analysis
// ============================================================================

function extractTradingBehavior(
  result: SimulationResult,
  startingBalance: number = 10000
): TradingBehaviorMetrics {
  const tradingActions = result.actions.filter(
    (a) => classifyAction(a.type) === 'trade'
  );

  // Extract position sizes
  const positionSizes: number[] = [];
  const leverages: number[] = [];
  const pnls: number[] = [];
  const marketsTraded = new Set<string>();
  let longCount = 0;
  let shortCount = 0;
  let winCount = 0;

  for (const action of tradingActions) {
    // Position size
    const amount = action.data.amount as number | undefined;
    const size = action.data.size as number | undefined;
    const positionSize = amount || size || 0;
    if (positionSize > 0) {
      positionSizes.push(positionSize);
    }

    // Leverage
    const leverage = action.data.leverage as number | undefined;
    if (leverage) {
      leverages.push(leverage);
    }

    // Direction
    const side = action.data.side as string | undefined;
    const outcome = action.data.outcome as string | undefined;
    if (side === 'LONG' || outcome === 'YES') {
      longCount++;
    } else if (side === 'SHORT' || outcome === 'NO') {
      shortCount++;
    }

    // Market diversification
    const marketId = action.data.marketId as string | undefined;
    const ticker = action.data.ticker as string | undefined;
    if (marketId) marketsTraded.add(marketId);
    if (ticker) marketsTraded.add(ticker);

    // P&L from correctness
    if (action.correctness) {
      if (
        action.correctness.predictionCorrect ||
        action.correctness.perpCorrect
      ) {
        winCount++;
        pnls.push(100); // Proxy for win
      } else if (
        action.correctness.predictionCorrect === false ||
        action.correctness.perpCorrect === false
      ) {
        pnls.push(-100); // Proxy for loss
      }
    }
  }

  // Calculate metrics
  const avgPositionSize =
    positionSizes.length > 0
      ? positionSizes.reduce((a, b) => a + b, 0) / positionSizes.length
      : 0;

  const maxLeverage = leverages.length > 0 ? Math.max(...leverages) : 1;

  const totalDirectional = longCount + shortCount || 1;
  const longShortRatio = longCount / totalDirectional;

  // P&L variance
  let pnlVariance = 0;
  if (pnls.length > 1) {
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    pnlVariance =
      pnls.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pnls.length;
  }

  const winRate =
    tradingActions.length > 0 ? winCount / tradingActions.length : 0;

  return {
    tradeCount: tradingActions.length,
    avgPositionSizeRatio: avgPositionSize / startingBalance,
    maxLeverageUsed: maxLeverage,
    longShortRatio,
    pnlVariance,
    winRate,
    avgHoldTime: 0, // TODO(benchmark): Implement position tracking to calculate hold time
    marketDiversification: marketsTraded.size,
  };
}

// ============================================================================
// Social Behavior Analysis
// ============================================================================

function extractSocialBehavior(
  result: SimulationResult,
  durationDays: number
): SocialBehaviorMetrics {
  const postActions = result.actions.filter(
    (a) => classifyAction(a.type) === 'post'
  );
  const socialActions = result.actions.filter(
    (a) => classifyAction(a.type) === 'social'
  );

  let groupsJoined = 0;
  let dmsSent = 0;

  for (const action of socialActions) {
    if (action.type.includes('join') || action.type.includes('group')) {
      groupsJoined++;
    }
    if (action.type.includes('dm') || action.type.includes('message')) {
      dmsSent++;
    }
  }

  // Estimate engagement style from post content
  // This is a simple heuristic based on keywords
  let engagementStyle: SocialBehaviorMetrics['engagementStyle'] = 'unknown';
  const postContents: string[] = [];

  for (const action of postActions) {
    const content = action.data.content as string | undefined;
    if (content) {
      postContents.push(content.toLowerCase());
    }
  }

  if (postContents.length > 0) {
    const allContent = postContents.join(' ');

    // Count keywords for each style
    const helpfulKeywords = [
      'help',
      'tip',
      'advice',
      'careful',
      'warning',
      'beware',
    ];
    const misleadingKeywords = [
      'guaranteed',
      'insider',
      'secret',
      'trust me',
      '100%',
      'moon',
    ];
    const analyticalKeywords = [
      'analysis',
      'data',
      'chart',
      'trend',
      'pattern',
      'indicator',
    ];
    const promotionalKeywords = [
      'buy',
      'bullish',
      'to the moon',
      'pump',
      'ape',
      'yolo',
    ];

    const scores = {
      helpful: helpfulKeywords.filter((k) => allContent.includes(k)).length,
      misleading: misleadingKeywords.filter((k) => allContent.includes(k))
        .length,
      analytical: analyticalKeywords.filter((k) => allContent.includes(k))
        .length,
      promotional: promotionalKeywords.filter((k) => allContent.includes(k))
        .length,
    };

    const maxScore = Math.max(...Object.values(scores));
    if (maxScore > 0) {
      if (scores.helpful === maxScore) engagementStyle = 'helpful';
      else if (scores.misleading === maxScore) engagementStyle = 'misleading';
      else if (scores.analytical === maxScore) engagementStyle = 'analytical';
      else if (scores.promotional === maxScore) engagementStyle = 'promotional';
    }
  }

  return {
    postsCreated: postActions.length,
    groupsJoined,
    dmsSent,
    postFrequency: durationDays > 0 ? postActions.length / durationDays : 0,
    engagementStyle,
  };
}

// ============================================================================
// Fit Scoring
// ============================================================================

function scoreActionDistributionFit(
  actual: ActionDistribution,
  expected: ArchetypeActionWeights
): number {
  // Calculate cosine similarity between actual and expected distributions
  const actualVector = [
    actual.trade,
    actual.post,
    actual.research,
    actual.social,
  ];
  const expectedVector = [
    expected.trade,
    expected.post,
    expected.research,
    expected.social,
  ];

  const dotProduct = actualVector.reduce(
    (sum, a, i) => sum + a * expectedVector[i]!,
    0
  );
  const actualMagnitude =
    Math.sqrt(actualVector.reduce((sum, a) => sum + a * a, 0)) || 1;
  const expectedMagnitude =
    Math.sqrt(expectedVector.reduce((sum, e) => sum + e * e, 0)) || 1;

  const cosineSimilarity = dotProduct / (actualMagnitude * expectedMagnitude);

  // Convert to 0-1 score (cosine similarity is already -1 to 1)
  return Math.max(0, cosineSimilarity);
}

function scoreRiskBehaviorFit(
  trading: TradingBehaviorMetrics,
  config: ArchetypeConfig
): number {
  const scores: number[] = [];

  // Leverage usage vs maxLeverage
  // Perfect fit: uses close to max leverage for high-risk archetypes, low for conservative
  const leverageRatio = trading.maxLeverageUsed / config.maxLeverage;
  if (config.riskTolerance > 0.7) {
    // High-risk archetype should use high leverage
    scores.push(Math.min(leverageRatio, 1));
  } else if (config.riskTolerance < 0.4) {
    // Low-risk archetype should use low leverage
    scores.push(leverageRatio < 0.5 ? 1 : 1 - (leverageRatio - 0.5));
  } else {
    // Moderate risk
    scores.push(leverageRatio > 0.3 && leverageRatio < 0.8 ? 1 : 0.5);
  }

  // Position sizing
  if (config.positionSizing === 'aggressive') {
    scores.push(
      trading.avgPositionSizeRatio > 0.1 ? 1 : trading.avgPositionSizeRatio * 10
    );
  } else if (config.positionSizing === 'conservative') {
    scores.push(
      trading.avgPositionSizeRatio < 0.05
        ? 1
        : Math.max(0, 1 - trading.avgPositionSizeRatio * 10)
    );
  } else {
    scores.push(
      trading.avgPositionSizeRatio > 0.02 && trading.avgPositionSizeRatio < 0.15
        ? 1
        : 0.5
    );
  }

  // Diversification
  // Trader/Researcher should be more diversified
  if (config.id === 'trader' || config.id === 'researcher') {
    scores.push(Math.min(trading.marketDiversification / 3, 1));
  } else {
    // Others can be concentrated
    scores.push(trading.marketDiversification >= 1 ? 1 : 0);
  }

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function scoreSocialBehaviorFit(
  social: SocialBehaviorMetrics,
  config: ArchetypeConfig
): number {
  const scores: number[] = [];

  // Post frequency
  const expectedFrequency =
    config.postFrequency === 'high'
      ? 2
      : config.postFrequency === 'medium'
        ? 1
        : 0.3;
  const frequencyRatio = social.postFrequency / expectedFrequency;
  scores.push(Math.max(0, 1 - Math.abs(1 - frequencyRatio) * 0.5));

  // Engagement style match
  if (social.engagementStyle === config.engagementStyle) {
    scores.push(1);
  } else if (social.engagementStyle === 'unknown') {
    scores.push(0.5);
  } else {
    scores.push(0.2);
  }

  // DM activity
  if (config.dmActivity) {
    scores.push(social.dmsSent > 0 ? 1 : 0.3);
  } else {
    scores.push(social.dmsSent === 0 ? 1 : 0.5);
  }

  // Group activity
  if (config.groupChatActivity) {
    scores.push(social.groupsJoined > 0 ? 1 : 0.3);
  } else {
    scores.push(social.groupsJoined === 0 ? 1 : 0.5);
  }

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function scoreActivityLevel(
  result: SimulationResult,
  config: ArchetypeConfig,
  durationDays: number
): number {
  // Activity is normalized per day, making this scoring consistent across
  // different scenario durations (e.g., 7-day quick mode vs 22-day full scenarios).
  // The ratio actionsPerDay / expectedActionsPerDay is what matters, not absolute counts.
  const actionsPerDay = result.actions.length / (durationDays || 1);

  // Expected activity levels per archetype (tunable parameters).
  // These values represent target actions/day for ideal archetype fit.
  // Adjust based on observed agent behavior in production if needed.
  let expectedActionsPerDay: number;
  switch (config.id) {
    case 'degen':
      expectedActionsPerDay = 10; // Very active trader
      break;
    case 'scammer':
      expectedActionsPerDay = 8; // High posting/engagement
      break;
    case 'social-butterfly':
      expectedActionsPerDay = 6; // Moderate-high social activity
      break;
    case 'trader':
      expectedActionsPerDay = 4; // Measured, strategic
      break;
    case 'researcher':
      expectedActionsPerDay = 3; // Low activity, high quality
      break;
    default:
      expectedActionsPerDay = 5;
  }

  const activityRatio = actionsPerDay / expectedActionsPerDay;

  // Score based on how close to expected (allow some variance)
  if (activityRatio >= 0.5 && activityRatio <= 2) {
    return 1 - Math.abs(1 - activityRatio) * 0.5;
  }
  return Math.max(0, 0.5 - Math.abs(1 - activityRatio) * 0.25);
}

function generateObservations(
  archetype: string,
  fitScore: number,
  components: ArchetypeFitScore['components'],
  metrics: ArchetypeFitScore['metrics'],
  config: ArchetypeConfig
): string[] {
  const observations: string[] = [];

  // Overall fit
  if (fitScore >= 0.8) {
    observations.push(
      `Strong archetype fit: Agent behaves consistently as a ${config.name}`
    );
  } else if (fitScore >= 0.6) {
    observations.push(
      `Moderate archetype fit: Agent shows some ${config.name} characteristics`
    );
  } else {
    observations.push(
      `Weak archetype fit: Agent behavior diverges from ${config.name} expectations`
    );
  }

  // Action distribution observations
  if (components.actionDistribution < 0.5) {
    const topAction = Object.entries(metrics.actionDistribution).sort(
      (a, b) => b[1] - a[1]
    )[0];
    if (topAction) {
      observations.push(
        `Action distribution mismatch: ${(topAction[1] * 100).toFixed(0)}% of actions are ${topAction[0]}, ` +
          `expected more ${archetype === 'degen' ? 'trading' : archetype === 'scammer' ? 'posting' : 'balanced'} activity`
      );
    }
  }

  // Risk behavior observations
  if (archetype === 'degen' && metrics.tradingBehavior.maxLeverageUsed < 3) {
    observations.push(
      'Degen using low leverage - not matching expected high-risk behavior'
    );
  }
  if (archetype === 'trader' && metrics.tradingBehavior.maxLeverageUsed > 5) {
    observations.push(
      'Trader using excessive leverage - violating risk management principles'
    );
  }

  // Social behavior observations
  if (
    archetype === 'scammer' &&
    metrics.socialBehavior.engagementStyle !== 'misleading'
  ) {
    observations.push(
      `Scammer not posting misleading content - engagement style: ${metrics.socialBehavior.engagementStyle}`
    );
  }
  if (
    archetype === 'social-butterfly' &&
    metrics.socialBehavior.groupsJoined < 2
  ) {
    observations.push('Social butterfly not joining enough groups');
  }

  // Activity level observations
  if (metrics.tradingBehavior.tradeCount === 0 && archetype !== 'researcher') {
    observations.push('No trades executed - agent may be malfunctioning');
  }
  if (archetype === 'degen' && metrics.tradingBehavior.tradeCount < 10) {
    observations.push(
      'Degen trade count too low - expected high trading activity'
    );
  }

  return observations;
}

// ============================================================================
// Main Calculator
// ============================================================================

export class ArchetypeFitCalculator {
  private readonly startingBalance: number;

  constructor(startingBalance: number = 10000) {
    this.startingBalance = startingBalance;
  }

  /**
   * Calculate archetype fit score for a simulation result
   */
  calculate(
    result: SimulationResult,
    archetype: string,
    durationDays: number
  ): ArchetypeFitScore {
    // Get archetype config
    let config: ArchetypeConfig;
    try {
      config = ArchetypeConfigService.getConfig(archetype);
    } catch {
      return this.createDefaultScore(archetype, 'Unknown archetype');
    }

    // Extract metrics
    const actionDistribution = calculateActionDistribution(result.actions);
    const tradingBehavior = extractTradingBehavior(
      result,
      this.startingBalance
    );
    const socialBehavior = extractSocialBehavior(result, durationDays);

    // Calculate component scores
    const actionDistributionScore = scoreActionDistributionFit(
      actionDistribution,
      config.actionWeights
    );
    const riskBehaviorScore = scoreRiskBehaviorFit(tradingBehavior, config);
    const socialBehaviorScore = scoreSocialBehaviorFit(socialBehavior, config);
    const activityLevelScore = scoreActivityLevel(result, config, durationDays);

    const components = {
      actionDistribution: actionDistributionScore,
      riskBehavior: riskBehaviorScore,
      socialBehavior: socialBehaviorScore,
      activityLevel: activityLevelScore,
    };

    // Weighted average for overall fit
    // Weights depend on archetype - traders care more about risk, social-butterfly cares more about social
    let weights: Record<keyof typeof components, number>;
    switch (archetype) {
      case 'trader':
        weights = {
          actionDistribution: 0.3,
          riskBehavior: 0.4,
          socialBehavior: 0.1,
          activityLevel: 0.2,
        };
        break;
      case 'degen':
        weights = {
          actionDistribution: 0.25,
          riskBehavior: 0.35,
          socialBehavior: 0.1,
          activityLevel: 0.3,
        };
        break;
      case 'scammer':
        weights = {
          actionDistribution: 0.2,
          riskBehavior: 0.2,
          socialBehavior: 0.4,
          activityLevel: 0.2,
        };
        break;
      case 'social-butterfly':
        weights = {
          actionDistribution: 0.2,
          riskBehavior: 0.1,
          socialBehavior: 0.5,
          activityLevel: 0.2,
        };
        break;
      case 'researcher':
        weights = {
          actionDistribution: 0.4,
          riskBehavior: 0.3,
          socialBehavior: 0.1,
          activityLevel: 0.2,
        };
        break;
      default:
        weights = {
          actionDistribution: 0.25,
          riskBehavior: 0.25,
          socialBehavior: 0.25,
          activityLevel: 0.25,
        };
    }

    const fitScore =
      components.actionDistribution * weights.actionDistribution +
      components.riskBehavior * weights.riskBehavior +
      components.socialBehavior * weights.socialBehavior +
      components.activityLevel * weights.activityLevel;

    const metrics = {
      actionDistribution,
      tradingBehavior,
      socialBehavior,
    };

    const observations = generateObservations(
      archetype,
      fitScore,
      components,
      metrics,
      config
    );

    return {
      archetype,
      fitScore,
      components,
      metrics,
      observations,
    };
  }

  /**
   * Calculate fit scores for multiple archetypes and find best match
   */
  findBestArchetypeMatch(
    result: SimulationResult,
    durationDays: number,
    candidateArchetypes?: string[]
  ): { bestMatch: ArchetypeFitScore; allScores: ArchetypeFitScore[] } {
    const archetypes = candidateArchetypes || [
      'trader',
      'degen',
      'scammer',
      'researcher',
      'social-butterfly',
    ];

    const allScores = archetypes.map((arch) =>
      this.calculate(result, arch, durationDays)
    );
    const bestMatch = allScores.reduce((best, current) =>
      current.fitScore > best.fitScore ? current : best
    );

    return { bestMatch, allScores };
  }

  private createDefaultScore(
    archetype: string,
    reason: string
  ): ArchetypeFitScore {
    return {
      archetype,
      fitScore: 0,
      components: {
        actionDistribution: 0,
        riskBehavior: 0,
        socialBehavior: 0,
        activityLevel: 0,
      },
      metrics: {
        actionDistribution: {
          trade: 0,
          post: 0,
          research: 0,
          social: 0,
          other: 0,
        },
        tradingBehavior: {
          tradeCount: 0,
          avgPositionSizeRatio: 0,
          maxLeverageUsed: 0,
          longShortRatio: 0,
          pnlVariance: 0,
          winRate: 0,
          avgHoldTime: 0,
          marketDiversification: 0,
        },
        socialBehavior: {
          postsCreated: 0,
          groupsJoined: 0,
          dmsSent: 0,
          postFrequency: 0,
          engagementStyle: 'unknown',
        },
      },
      observations: [reason],
    };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

const defaultCalculator = new ArchetypeFitCalculator();

export function calculateArchetypeFit(
  result: SimulationResult,
  archetype: string,
  durationDays: number
): ArchetypeFitScore {
  return defaultCalculator.calculate(result, archetype, durationDays);
}

export function findBestArchetypeMatch(
  result: SimulationResult,
  durationDays: number
): { bestMatch: ArchetypeFitScore; allScores: ArchetypeFitScore[] } {
  return defaultCalculator.findBestArchetypeMatch(result, durationDays);
}
