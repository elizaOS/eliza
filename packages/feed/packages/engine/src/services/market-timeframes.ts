/**
 * Market Timeframes Service
 *
 * Defines market types with different resolution timeframes, inspired by Polymarket's
 * diverse market durations. Markets range from 15-minute flash markets to multi-month
 * long-term predictions.
 *
 * ## Market Type Hierarchy
 *
 * ```
 * LONG-TERM ARC (30 days - 3 months)
 * └── Main Question: "Will Aipple release the AI Phone this quarter?"
 *     ├── WEEKLY SUB-MARKET (7 days)
 *     │   └── "Will Sim Cook mention AI Phone at WWDC?"
 *     │       ├── DAILY SUB-MARKET (24-48 hours)
 *     │       │   └── "Will Aipple stock close above $180 today?"
 *     │       └── INTRADAY SUB-MARKET (1-6 hours)
 *     │           └── "Will the keynote receive positive initial reception?"
 *     │               └── FLASH MARKET (15-30 minutes)
 *     │                   └── "Will Sim Cook demo a new product in the first 30 min?"
 *     └── WEEKLY SUB-MARKET (7 days)
 *         └── "Will supply chain leaks confirm AI Phone components?"
 * ```
 *
 * ## Timeframe Categories (inspired by Polymarket)
 *
 * 1. **Flash Markets** (15-30 min): Live event betting
 *    - Sports: "Will this drive result in a touchdown?"
 *    - Keynotes: "Will a specific announcement be made?"
 *    - Breaking News: "Will stock move 1% in next 15 min?"
 *
 * 2. **Intraday Markets** (1-6 hours): Same-day resolution
 *    - Market closes: "Will stock close green today?"
 *    - Event outcomes: "What will be announced at the conference?"
 *
 * 3. **Daily Markets** (12-48 hours): Next-day resolution
 *    - Earnings: "Will company beat earnings estimates?"
 *    - News: "Will story develop further tomorrow?"
 *
 * 4. **Weekly Markets** (3-7 days): Short-term trends
 *    - Product launches: "Will launch go smoothly this week?"
 *    - Political: "Will bill pass committee this week?"
 *
 * 5. **Monthly Markets** (2-4 weeks): Medium-term outcomes
 *    - Business: "Will deal close this month?"
 *    - Regulatory: "Will approval be granted this month?"
 *
 * 6. **Quarterly/Long-Term Markets** (1-3+ months): Strategic outcomes
 *    - Product launches: "Will product ship this quarter?"
 *    - Elections: "Who will win the election?"
 *    - Crypto: "Will BTC reach $100k this year?"
 */

import type {
  ArcStateType,
  LongTermArcState,
  MarketCategory,
  MarketTimeframe,
} from '@feed/db';
import { logger } from '@feed/shared';
import { clamp01 } from '../utils/math-utils';

// Re-export types from DB schema for consumers of this module
// Arc state types are canonical in @feed/db/schema/narrative.ts
export type {
  ArcStateType,
  DailyArcState,
  FlashArcState,
  IntradayArcState,
  LongTermArcState,
  MarketCategory,
  MarketTimeframe,
  WeeklyArcState,
} from '@feed/db';

/**
 * Standard arc state alias for weekly/monthly/quarterly markets.
 * These use the same state progression as LongTermArcState but over shorter periods.
 */
export type StandardArcState = LongTermArcState;

/**
 * Configuration for a market timeframe
 */
export interface TimeframeConfig {
  /** Human-readable name */
  name: string;
  /** Minimum duration in minutes */
  minDurationMinutes: number;
  /** Maximum duration in minutes */
  maxDurationMinutes: number;
  /** Default duration in minutes */
  defaultDurationMinutes: number;
  /** Arc states for this timeframe */
  arcStates: string[];
  /** Minimum event cooldown in minutes */
  eventCooldownMinutes: number;
  /** Can spawn child markets? */
  canSpawnChildren: boolean;
  /** Allowed child timeframes */
  childTimeframes: MarketTimeframe[];
  /** NPC posting frequency multiplier */
  postingMultiplier: number;
  /** Event generation probability multiplier */
  eventMultiplier: number;
}

/**
 * Sub-market spawn trigger
 */
export interface SubMarketTrigger {
  /** Event type that triggers spawn */
  eventType: string;
  /** Probability of spawning (0-1) */
  spawnProbability: number;
  /** Timeframe for spawned market */
  childTimeframe: MarketTimeframe;
  /** Template for generating question */
  questionTemplate: string;
  /** Duration modifier (multiplier on default) */
  durationModifier?: number;
  /** Template var key to use as the topic label (e.g., 'org', 'ticker', 'team') */
  topicSourceVar?: string;
}

/**
 * Market with timeframe metadata
 */
export interface TimeframedMarket {
  id: string;
  questionId: string;
  timeframe: MarketTimeframe;
  category: MarketCategory;
  parentMarketId?: string;
  startTime: Date;
  endTime: Date;
  arcState: string;
  arcStateEnteredAt: Date;
  childMarketIds: string[];
  metadata?: {
    eventId?: string; // Source event that spawned this
    triggeredBy?: string; // Parent market event
    affiliatedOrgs?: string[];
    affiliatedActors?: string[];
  };
}

// =============================================================================
// GRANULAR TIMEFRAME TO DB TIMEFRAME MAPPING
// =============================================================================

/**
 * Maps granular timeframe strings (like '15m', '30m', '1h') to their
 * corresponding DB timeframe categories ('flash', 'intraday', 'daily', 'weekly').
 *
 * This is the canonical source of truth for this mapping, used by:
 * - markets-tick cron for market creation and tracking
 * - Integration tests for validation
 */
export const GRANULAR_TO_DB_TIMEFRAME: Record<string, MarketTimeframe> = {
  '15m': 'flash',
  '30m': 'flash',
  '1h': 'intraday',
  '6h': 'intraday',
  '12h': 'daily',
  '1d': 'daily',
  '2d': 'weekly',
  '3d': 'weekly',
} as const;

/**
 * Map a granular timeframe string to its DB timeframe category.
 * Throws an error for unknown timeframes to fail fast.
 *
 * @param timeframe - Granular timeframe string (e.g., '15m', '1h', '1d')
 * @returns The corresponding DB timeframe category
 * @throws Error if timeframe is not recognized
 */
export function mapGranularToDbTimeframe(timeframe: string): MarketTimeframe {
  const dbTimeframe = GRANULAR_TO_DB_TIMEFRAME[timeframe];
  if (!dbTimeframe) {
    throw new Error(`Unsupported granular timeframe: ${timeframe}`);
  }
  return dbTimeframe;
}

// =============================================================================
// TIMEFRAME CONFIGURATIONS
// =============================================================================

export const TIMEFRAME_CONFIGS: Record<MarketTimeframe, TimeframeConfig> = {
  flash: {
    name: 'Flash Market',
    minDurationMinutes: 15,
    maxDurationMinutes: 30,
    defaultDurationMinutes: 15,
    arcStates: ['live', 'resolving'],
    eventCooldownMinutes: 2,
    canSpawnChildren: false,
    childTimeframes: [],
    postingMultiplier: 3.0, // Very high activity
    eventMultiplier: 0.5, // Few events, fast resolution
  },

  intraday: {
    name: 'Intraday Market',
    minDurationMinutes: 60, // 1 hour
    maxDurationMinutes: 360, // 6 hours
    defaultDurationMinutes: 180, // 3 hours
    arcStates: ['setup', 'active', 'climax', 'resolution'],
    eventCooldownMinutes: 15,
    canSpawnChildren: true,
    childTimeframes: ['flash'],
    postingMultiplier: 2.0,
    eventMultiplier: 1.0,
  },

  daily: {
    name: 'Daily Market',
    minDurationMinutes: 720, // 12 hours
    maxDurationMinutes: 2880, // 48 hours
    defaultDurationMinutes: 1440, // 24 hours
    arcStates: ['morning', 'midday', 'afternoon', 'evening', 'resolution'],
    eventCooldownMinutes: 30,
    canSpawnChildren: true,
    childTimeframes: ['flash', 'intraday'],
    postingMultiplier: 1.5,
    eventMultiplier: 1.2,
  },

  weekly: {
    name: 'Weekly Market',
    minDurationMinutes: 4320, // 3 days
    maxDurationMinutes: 10080, // 7 days
    defaultDurationMinutes: 7200, // 5 days
    arcStates: ['setup', 'tension', 'escalation', 'crisis', 'resolution'],
    eventCooldownMinutes: 60,
    canSpawnChildren: true,
    childTimeframes: ['flash', 'intraday', 'daily'],
    postingMultiplier: 1.2,
    eventMultiplier: 1.5,
  },

  monthly: {
    name: 'Monthly Market',
    minDurationMinutes: 20160, // 14 days
    maxDurationMinutes: 40320, // 28 days
    defaultDurationMinutes: 30240, // 21 days
    arcStates: [
      'setup',
      'tension',
      'escalation',
      'crisis',
      'revelation',
      'resolution',
    ],
    eventCooldownMinutes: 120, // 2 hours
    canSpawnChildren: true,
    childTimeframes: ['flash', 'intraday', 'daily', 'weekly'],
    postingMultiplier: 1.0,
    eventMultiplier: 1.5,
  },

  quarterly: {
    name: 'Quarterly Market',
    minDurationMinutes: 43200, // 30 days
    maxDurationMinutes: 129600, // 90 days
    defaultDurationMinutes: 64800, // 45 days
    arcStates: [
      'setup',
      'tension',
      'escalation',
      'crisis',
      'revelation',
      'resolution',
    ],
    eventCooldownMinutes: 120,
    canSpawnChildren: true,
    childTimeframes: ['flash', 'intraday', 'daily', 'weekly', 'monthly'],
    postingMultiplier: 1.0,
    eventMultiplier: 2.0,
  },

  longterm: {
    name: 'Long-Term Market',
    minDurationMinutes: 129600, // 90 days
    maxDurationMinutes: 525600, // 365 days
    defaultDurationMinutes: 259200, // 180 days
    arcStates: [
      'setup',
      'tension',
      'escalation',
      'crisis',
      'revelation',
      'resolution',
    ],
    eventCooldownMinutes: 240, // 4 hours
    canSpawnChildren: true,
    childTimeframes: [
      'flash',
      'intraday',
      'daily',
      'weekly',
      'monthly',
      'quarterly',
    ],
    postingMultiplier: 0.8,
    eventMultiplier: 2.5,
  },
};

// =============================================================================
// SUB-MARKET TRIGGERS BY CATEGORY
// =============================================================================

/**
 * Trigger configurations for spawning sub-markets from events
 */
export const SUB_MARKET_TRIGGERS: Record<MarketCategory, SubMarketTrigger[]> = {
  tech: [
    {
      eventType: 'announcement',
      spawnProbability: 0.8,
      childTimeframe: 'intraday',
      questionTemplate:
        'Will {org} stock move more than {threshold}% following the announcement?',
      topicSourceVar: 'org',
    },
    {
      eventType: 'keynote_start',
      spawnProbability: 0.9,
      childTimeframe: 'flash',
      questionTemplate:
        'Will {actor} announce a new product in the first 30 minutes?',
      topicSourceVar: 'actor',
    },
    {
      eventType: 'product_leak',
      spawnProbability: 0.6,
      childTimeframe: 'daily',
      questionTemplate: 'Will {org} confirm or deny the leak within 24 hours?',
      topicSourceVar: 'org',
    },
    {
      eventType: 'earnings_scheduled',
      spawnProbability: 0.95,
      childTimeframe: 'daily',
      questionTemplate: 'Will {org} beat earnings estimates?',
      topicSourceVar: 'org',
    },
  ],

  crypto: [
    {
      eventType: 'price_breakout',
      spawnProbability: 0.7,
      childTimeframe: 'flash',
      questionTemplate:
        'Will {ticker} hold above {price} for the next 15 minutes?',
      topicSourceVar: 'ticker',
    },
    {
      eventType: 'whale_movement',
      spawnProbability: 0.5,
      childTimeframe: 'intraday',
      questionTemplate: 'Will {ticker} move more than 5% in the next 4 hours?',
      topicSourceVar: 'ticker',
    },
    {
      eventType: 'protocol_upgrade',
      spawnProbability: 0.8,
      childTimeframe: 'daily',
      questionTemplate: 'Will the {protocol} upgrade complete without issues?',
      topicSourceVar: 'protocol',
    },
  ],

  politics: [
    {
      eventType: 'vote_scheduled',
      spawnProbability: 0.9,
      childTimeframe: 'intraday',
      questionTemplate: 'Will the bill pass the {chamber} vote?',
      topicSourceVar: 'chamber',
    },
    {
      eventType: 'debate',
      spawnProbability: 0.8,
      childTimeframe: 'flash',
      questionTemplate:
        'Will {candidate} mention {topic} in the first 30 minutes?',
      topicSourceVar: 'candidate',
    },
    {
      eventType: 'poll_release',
      spawnProbability: 0.6,
      childTimeframe: 'daily',
      questionTemplate:
        'Will {candidate} lead in the next major poll released?',
      topicSourceVar: 'candidate',
    },
  ],

  sports: [
    {
      eventType: 'game_start',
      spawnProbability: 1.0,
      childTimeframe: 'flash',
      questionTemplate: 'Will {team} score first?',
      topicSourceVar: 'team',
    },
    {
      eventType: 'halftime',
      spawnProbability: 0.9,
      childTimeframe: 'flash',
      questionTemplate: 'Will {team} win the second half?',
      topicSourceVar: 'team',
    },
    {
      eventType: 'injury_report',
      spawnProbability: 0.7,
      childTimeframe: 'daily',
      questionTemplate: 'Will {player} play in the next game?',
      topicSourceVar: 'player',
    },
  ],

  business: [
    {
      eventType: 'merger_rumor',
      spawnProbability: 0.7,
      childTimeframe: 'weekly',
      questionTemplate:
        'Will {org1} and {org2} confirm merger talks this week?',
      topicSourceVar: 'org1',
    },
    {
      eventType: 'ipo_filing',
      spawnProbability: 0.8,
      childTimeframe: 'monthly',
      questionTemplate: 'Will {company} price above ${price} per share?',
      topicSourceVar: 'company',
    },
    {
      eventType: 'ceo_resignation',
      spawnProbability: 0.6,
      childTimeframe: 'daily',
      questionTemplate: 'Will {org} announce a replacement within 48 hours?',
      topicSourceVar: 'org',
    },
  ],

  entertainment: [
    {
      eventType: 'awards_ceremony',
      spawnProbability: 0.9,
      childTimeframe: 'flash',
      questionTemplate: 'Will {nominee} win {award}?',
      topicSourceVar: 'nominee',
    },
    {
      eventType: 'release_weekend',
      spawnProbability: 0.8,
      childTimeframe: 'intraday',
      questionTemplate:
        'Will {movie} gross over ${amount}M in opening weekend?',
      topicSourceVar: 'movie',
    },
  ],

  science: [
    {
      eventType: 'launch_window',
      spawnProbability: 0.9,
      childTimeframe: 'flash',
      questionTemplate: 'Will the {mission} launch successfully?',
      topicSourceVar: 'mission',
    },
    {
      eventType: 'fda_decision',
      spawnProbability: 0.85,
      childTimeframe: 'daily',
      questionTemplate: 'Will {drug} receive FDA approval?',
      topicSourceVar: 'drug',
    },
  ],

  general: [
    {
      eventType: 'breaking_news',
      spawnProbability: 0.5,
      childTimeframe: 'intraday',
      questionTemplate: 'Will this story develop further in the next 6 hours?',
    },
  ],
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get timeframe from duration in minutes
 */
export function getTimeframeFromDuration(
  durationMinutes: number
): MarketTimeframe {
  // Use maxDurationMinutes from config to avoid gaps between timeframes
  if (durationMinutes <= TIMEFRAME_CONFIGS.flash.maxDurationMinutes)
    return 'flash';
  if (durationMinutes <= TIMEFRAME_CONFIGS.intraday.maxDurationMinutes)
    return 'intraday';
  if (durationMinutes <= TIMEFRAME_CONFIGS.daily.maxDurationMinutes)
    return 'daily';
  if (durationMinutes <= TIMEFRAME_CONFIGS.weekly.maxDurationMinutes)
    return 'weekly';
  if (durationMinutes <= TIMEFRAME_CONFIGS.monthly.maxDurationMinutes)
    return 'monthly';
  if (durationMinutes <= TIMEFRAME_CONFIGS.quarterly.maxDurationMinutes)
    return 'quarterly';
  return 'longterm';
}

/**
 * Calculate end time from start and timeframe
 */
export function calculateEndTime(
  startTime: Date,
  timeframe: MarketTimeframe,
  durationModifier = 1.0
): Date {
  const config = TIMEFRAME_CONFIGS[timeframe];
  const durationMinutes = Math.round(
    config.defaultDurationMinutes * durationModifier
  );
  const clampedDuration = Math.max(
    config.minDurationMinutes,
    Math.min(config.maxDurationMinutes, durationMinutes)
  );

  return new Date(startTime.getTime() + clampedDuration * 60 * 1000);
}

/**
 * Get current arc state based on elapsed time
 */
export function getCurrentArcState(
  startTime: Date,
  endTime: Date,
  timeframe: MarketTimeframe,
  now: Date = new Date()
): ArcStateType {
  const config = TIMEFRAME_CONFIGS[timeframe];
  const states = config.arcStates;

  // Handle empty states array
  if (states.length === 0) {
    return 'setup';
  }

  // Edge case: if before start time, return first state
  if (now.getTime() <= startTime.getTime()) {
    return (states[0] ?? 'setup') as ArcStateType;
  }

  // Edge case: if at or after end time, return last state
  if (now.getTime() >= endTime.getTime()) {
    return (states[states.length - 1] ?? 'setup') as ArcStateType;
  }

  const totalDuration = endTime.getTime() - startTime.getTime();

  // Edge case: if duration is zero or negative, return last state
  if (totalDuration <= 0) {
    return (states[states.length - 1] ?? 'setup') as ArcStateType;
  }

  const elapsed = now.getTime() - startTime.getTime();
  const progress = clamp01(elapsed / totalDuration);

  // Map progress to state index
  const stateIndex = Math.min(
    states.length - 1,
    Math.floor(progress * states.length)
  );

  // Safe access with guaranteed fallback
  const state = states[stateIndex];
  if (state !== undefined) {
    return state as ArcStateType;
  }
  // Fallback should never happen given the Math.min above, but TypeScript requires it
  return (states[0] ?? 'setup') as ArcStateType;
}

/**
 * Calculate state phase boundaries for a timeframe
 */
export function getStateBoundaries(
  startTime: Date,
  endTime: Date,
  timeframe: MarketTimeframe
): Array<{ state: string; start: Date; end: Date }> {
  const config = TIMEFRAME_CONFIGS[timeframe];
  const states = config.arcStates;

  // Guard against division by zero when no arc states are defined
  if (states.length === 0) {
    throw new Error(
      `getStateBoundaries: no arcStates defined for timeframe '${timeframe}'`
    );
  }

  const totalDuration = endTime.getTime() - startTime.getTime();

  // Guard against invalid time range (endTime must be after startTime)
  if (totalDuration <= 0) {
    throw new Error(
      `getStateBoundaries: endTime must be after startTime for timeframe '${timeframe}'. ` +
        `startTime: ${startTime.toISOString()}, endTime: ${endTime.toISOString()}`
    );
  }

  const phaseDuration = totalDuration / states.length;

  return states.map((state, index) => ({
    state,
    start: new Date(startTime.getTime() + index * phaseDuration),
    end: new Date(startTime.getTime() + (index + 1) * phaseDuration),
  }));
}

/**
 * Check if an event should spawn a sub-market
 *
 * @param eventType - The type of event that occurred
 * @param category - The market category
 * @param parentTimeframe - The parent market's timeframe
 * @param randomValue - Optional random value (0-1) for deterministic testing. Defaults to Math.random().
 */
export function shouldSpawnSubMarket(
  eventType: string,
  category: MarketCategory,
  parentTimeframe: MarketTimeframe,
  randomValue?: number
): SubMarketTrigger | null {
  const config = TIMEFRAME_CONFIGS[parentTimeframe];

  if (!config.canSpawnChildren) {
    return null;
  }

  const triggers = SUB_MARKET_TRIGGERS[category] ?? [];
  const matchingTrigger = triggers.find((t) => t.eventType === eventType);

  if (!matchingTrigger) {
    return null;
  }

  // Check if child timeframe is allowed
  if (!config.childTimeframes.includes(matchingTrigger.childTimeframe)) {
    return null;
  }

  // Check probability
  const rand = randomValue ?? Math.random();
  if (rand > matchingTrigger.spawnProbability) {
    logger.debug(
      `Sub-market spawn skipped (probability check failed)`,
      {
        eventType,
        category,
        probability: matchingTrigger.spawnProbability,
      },
      'MarketTimeframes'
    );
    return null;
  }

  return matchingTrigger;
}

/**
 * Get event cooldown for a timeframe
 */
export function getEventCooldownMs(timeframe: MarketTimeframe): number {
  const config = TIMEFRAME_CONFIGS[timeframe];
  return config.eventCooldownMinutes * 60 * 1000;
}

/**
 * Get posting multiplier for a timeframe
 */
export function getPostingMultiplier(timeframe: MarketTimeframe): number {
  return TIMEFRAME_CONFIGS[timeframe].postingMultiplier;
}

/**
 * Get event multiplier for a timeframe
 */
export function getEventMultiplier(timeframe: MarketTimeframe): number {
  return TIMEFRAME_CONFIGS[timeframe].eventMultiplier;
}

/**
 * Validate market duration against timeframe constraints
 */
export function validateDuration(
  durationMinutes: number,
  timeframe: MarketTimeframe
): { valid: boolean; message?: string } {
  const config = TIMEFRAME_CONFIGS[timeframe];

  if (durationMinutes < config.minDurationMinutes) {
    return {
      valid: false,
      message: `Duration ${durationMinutes}min is below minimum ${config.minDurationMinutes}min for ${timeframe}`,
    };
  }

  if (durationMinutes > config.maxDurationMinutes) {
    return {
      valid: false,
      message: `Duration ${durationMinutes}min exceeds maximum ${config.maxDurationMinutes}min for ${timeframe}`,
    };
  }

  return { valid: true };
}

// =============================================================================
// SERVICE CLASS
// =============================================================================

export class MarketTimeframeService {
  getConfig(timeframe: MarketTimeframe): TimeframeConfig {
    return TIMEFRAME_CONFIGS[timeframe];
  }

  getTimeframeFromDuration(durationMinutes: number): MarketTimeframe {
    return getTimeframeFromDuration(durationMinutes);
  }

  calculateEndTime(
    startTime: Date,
    timeframe: MarketTimeframe,
    durationModifier?: number
  ): Date {
    return calculateEndTime(startTime, timeframe, durationModifier);
  }

  getCurrentArcState(
    startTime: Date,
    endTime: Date,
    timeframe: MarketTimeframe,
    now?: Date
  ): ArcStateType {
    return getCurrentArcState(startTime, endTime, timeframe, now);
  }

  getStateBoundaries(
    startTime: Date,
    endTime: Date,
    timeframe: MarketTimeframe
  ): Array<{ state: string; start: Date; end: Date }> {
    return getStateBoundaries(startTime, endTime, timeframe);
  }

  shouldSpawnSubMarket(
    eventType: string,
    category: MarketCategory,
    parentTimeframe: MarketTimeframe,
    randomValue?: number
  ): SubMarketTrigger | null {
    return shouldSpawnSubMarket(
      eventType,
      category,
      parentTimeframe,
      randomValue
    );
  }

  getTriggers(category: MarketCategory): SubMarketTrigger[] {
    return SUB_MARKET_TRIGGERS[category] ?? [];
  }
}

// Singleton instance
export const marketTimeframeService = new MarketTimeframeService();
