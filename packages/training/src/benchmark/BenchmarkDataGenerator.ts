/**
 * Benchmark Data Generator
 *
 * Generates deterministic benchmark scenarios for agent testing.
 * Creates pre-recorded game states with known outcomes for reproducible testing.
 *
 * Supports two modes:
 * 1. Random Walk Mode (default): Prices follow random walk with drift
 * 2. Causal Simulation Mode: Hidden facts → Events → Price movements (learnable signal)
 */

import type { JsonValue } from "../adapter";
import { logger } from "../utils/logger";

/**
 * Volatility bucket for price movements
 * - low: Small price movements (-2% to -4% or +2% to +4%)
 * - medium: Moderate price movements (-5% to -10% or +5% to +10%)
 * - high: Large price movements (-15%+ or +15%+)
 */
export type VolatilityBucket = "low" | "medium" | "high";

/**
 * Event types that can be generated from hidden facts
 */
export type CausalEventType =
  | "leak"
  | "rumor"
  | "scandal"
  | "development"
  | "deal"
  | "announcement";

/**
 * Scheduled event in the causal event schedule
 * Events are scheduled with a base day and hour, plus jitter
 */
export interface ScheduledCausalEvent {
  /** Base day for the event (1-30) */
  baseDay: number;
  /** Base hour for the event (0-23) */
  baseHour: number;
  /** Jitter applied to the event timing in hours (calculated from seed) */
  jitterHours: number;
  /** Type of event */
  eventType: CausalEventType;
  /** Volatility bucket for price impact */
  volatilityBucket: VolatilityBucket;
  /** Whether the event is positive (true) or negative (false) for affected tickers */
  isPositive: boolean;
  /** Description template for the event */
  descriptionTemplate: string;
}

/**
 * Hidden narrative fact that drives causal events
 * Each fact has a sequence of events that unfold over time
 */
export interface HiddenNarrativeFact {
  /** Unique identifier for the fact */
  id: string;
  /** The hidden fact description (e.g., "TeslAI has a secret battery flaw") */
  fact: string;
  /** Tickers affected by this fact */
  affectsTickers: string[];
  /** Sequence of events scheduled to occur based on this fact */
  eventSchedule: ScheduledCausalEvent[];
  /** Overall sentiment of the narrative: negative facts lead to price drops */
  sentiment: "positive" | "negative";
}

export interface BenchmarkConfig {
  /** Duration of benchmark in minutes */
  durationMinutes: number;

  /** Interval between ticks in seconds */
  tickInterval: number;

  /** Number of prediction markets */
  numPredictionMarkets: number;

  /** Number of perpetual markets */
  numPerpetualMarkets: number;

  /** Number of other simulated agents */
  numAgents: number;

  /** Random seed for reproducibility */
  seed?: number;

  /**
   * Enable causal simulation mode
   * When true, prices are driven by events from hidden facts instead of random walk
   * Default: false (backward compatible)
   */
  useCausalSimulation?: boolean;
}

export interface GameState {
  tick: number;
  timestamp: number;
  predictionMarkets: PredictionMarket[];
  perpetualMarkets: PerpetualMarket[];
  agents: SimulatedAgent[];
  posts?: Post[];
  groupChats?: GroupChat[];
}

export interface PredictionMarket {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  yesPrice: number;
  noPrice: number;
  totalVolume: number;
  liquidity: number;
  resolved: boolean;
  createdAt: number;
  resolveAt: number;
}

export interface PerpetualMarket {
  ticker: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime: number;
}

export interface SimulatedAgent {
  id: string;
  name: string;
  reputation: number;
  totalPnl: number;
}

export interface Post {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  likes: number;
  comments: number;
  marketId?: string;
}

export interface GroupChat {
  id: string;
  name: string;
  memberIds: string[];
  messageCount: number;
  lastActivity: number;
  invitedAgent?: boolean;
  messages?: Array<{
    id: string;
    authorId: string;
    authorName: string;
    content: string;
    timestamp: number;
  }>;
}

export interface Tick {
  number: number;
  timestamp: number;
  events: TickEvent[];
  state: GameState;
}

export interface TickEvent {
  type: string;
  timestamp: number;
  data: Record<string, JsonValue>;
}

export interface GroundTruth {
  // =========================================================================
  // REAL DATA - Used for training and evaluation
  // =========================================================================

  /** Known market outcomes (marketId -> boolean) - REAL */
  marketOutcomes: Record<string, boolean>;

  /**
   * Historical price data - REAL
   * In causal mode: prices change only at event ticks
   * In random walk mode: prices follow random walk each tick
   */
  priceHistory: Record<
    string,
    Array<{ tick: number; timestamp: number; price: number }>
  >;

  /**
   * Hidden narrative facts that drive causal events - REAL (Causal Mode only)
   * Each fact generates a sequence of events that affect specific tickers
   */
  hiddenNarrativeFacts?: HiddenNarrativeFact[];

  /**
   * Causal events with pre-calculated timing and price changes - REAL (Causal Mode only)
   * These events causally drive price movements, creating a learnable signal
   */
  causalEvents?: Array<{
    tick: number;
    day: number;
    hour: number;
    eventType: CausalEventType;
    description: string;
    affectedTickers: string[];
    volatilityBucket: VolatilityBucket;
    isPositive: boolean;
    /** Pre-calculated percentage change for each ticker (e.g., -0.07 for -7%) */
    priceChanges: Record<string, number>;
    sourceFactId: string;
  }>;

  // =========================================================================
  // LEGACY/SYNTHETIC DATA - For backward compatibility only
  // These fields contain placeholder values, NOT real ground truth
  // =========================================================================

  /**
   * @deprecated SYNTHETIC placeholder - simple heuristic, not real optimal actions
   */
  optimalActions: Array<{
    tick: number;
    type: string;
    target: string;
    expectedValue: number;
    reason: string;
  }>;

  /**
   * @deprecated SYNTHETIC placeholder - not real social opportunities
   */
  socialOpportunities: Array<{
    tick: number;
    type: string;
    value: number;
    description: string;
  }>;

  /**
   * @deprecated SYNTHETIC - empty array, never meaningfully implemented
   */
  hiddenFacts: Array<{
    tick: number;
    fact: string;
    category: "market" | "social" | "event" | "insider";
    value: JsonValue;
  }>;

  /**
   * @deprecated SYNTHETIC - empty array, never meaningfully implemented
   */
  hiddenEvents: Array<{
    tick: number;
    type: string;
    description: string;
    impact: Record<string, JsonValue>;
  }>;

  /** Computed facts from initial state (not synthetic, but not all fields are meaningful) */
  trueFacts: Record<string, JsonValue>;
}

export interface BenchmarkGameSnapshot {
  id: string;
  version: string;
  createdAt: number;
  duration: number;
  tickInterval: number;
  initialState: GameState;
  ticks: Tick[];
  groundTruth: GroundTruth;
}

/**
 * Narrative fact templates for causal simulation
 * Each template defines a hidden fact and its event sequence
 */
const NARRATIVE_FACT_TEMPLATES: Array<{
  factTemplate: string;
  sentiment: "positive" | "negative";
  /** Event sequence with relative timing and volatility */
  eventSequence: Array<{
    relativeDay: number; // Days from start (e.g., 5, 10, 15)
    eventType: CausalEventType;
    volatilityBucket: VolatilityBucket;
    descriptionTemplate: string;
  }>;
}> = [
  // Negative narratives (price drops)
  {
    factTemplate:
      "{ticker} has a secret product flaw that will require a recall",
    sentiment: "negative",
    eventSequence: [
      {
        relativeDay: 5,
        eventType: "leak",
        volatilityBucket: "medium",
        descriptionTemplate:
          "Internal documents leaked: {ticker} product flaw discovered by engineers",
      },
      {
        relativeDay: 10,
        eventType: "rumor",
        volatilityBucket: "medium",
        descriptionTemplate:
          "Industry sources report potential {ticker} recall due to safety issues",
      },
      {
        relativeDay: 18,
        eventType: "scandal",
        volatilityBucket: "high",
        descriptionTemplate:
          "{ticker} board meeting: CEO denies cover-up allegations as evidence mounts",
      },
    ],
  },
  {
    factTemplate: "{ticker} is secretly insolvent and hiding massive losses",
    sentiment: "negative",
    eventSequence: [
      {
        relativeDay: 4,
        eventType: "rumor",
        volatilityBucket: "low",
        descriptionTemplate:
          "Anonymous source claims {ticker} accounting irregularities",
      },
      {
        relativeDay: 12,
        eventType: "leak",
        volatilityBucket: "medium",
        descriptionTemplate:
          'Leaked memo reveals {ticker} executives discussing "liquidity concerns"',
      },
      {
        relativeDay: 20,
        eventType: "scandal",
        volatilityBucket: "high",
        descriptionTemplate:
          "Whistleblower exposes {ticker} hidden debt: stock halted pending investigation",
      },
    ],
  },
  {
    factTemplate: "{ticker} CEO is about to be indicted for fraud",
    sentiment: "negative",
    eventSequence: [
      {
        relativeDay: 6,
        eventType: "rumor",
        volatilityBucket: "low",
        descriptionTemplate:
          "Rumors swirl about {ticker} CEO facing regulatory scrutiny",
      },
      {
        relativeDay: 14,
        eventType: "leak",
        volatilityBucket: "medium",
        descriptionTemplate:
          "Sources close to investigation: {ticker} CEO under federal probe",
      },
      {
        relativeDay: 22,
        eventType: "announcement",
        volatilityBucket: "high",
        descriptionTemplate:
          "{ticker} confirms CEO departure amid ongoing investigation",
      },
    ],
  },
  // Positive narratives (price increases)
  {
    factTemplate:
      "{ticker} is about to announce a breakthrough product that will dominate the market",
    sentiment: "positive",
    eventSequence: [
      {
        relativeDay: 5,
        eventType: "rumor",
        volatilityBucket: "low",
        descriptionTemplate:
          "Insider whispers: {ticker} working on game-changing technology",
      },
      {
        relativeDay: 12,
        eventType: "leak",
        volatilityBucket: "medium",
        descriptionTemplate:
          "Leaked patent filings suggest {ticker} breakthrough imminent",
      },
      {
        relativeDay: 20,
        eventType: "announcement",
        volatilityBucket: "high",
        descriptionTemplate:
          "{ticker} announces revolutionary product: analysts upgrade to strong buy",
      },
    ],
  },
  {
    factTemplate: "{ticker} is the secret acquisition target of a tech giant",
    sentiment: "positive",
    eventSequence: [
      {
        relativeDay: 4,
        eventType: "rumor",
        volatilityBucket: "low",
        descriptionTemplate:
          "M&A rumors surface: {ticker} reportedly in acquisition talks",
      },
      {
        relativeDay: 10,
        eventType: "leak",
        volatilityBucket: "medium",
        descriptionTemplate:
          "Anonymous source: {ticker} board reviewing buyout offer at premium",
      },
      {
        relativeDay: 16,
        eventType: "deal",
        volatilityBucket: "high",
        descriptionTemplate:
          "{ticker} confirms acquisition discussions: shares surge on takeover premium",
      },
    ],
  },
  {
    factTemplate: "{ticker} has secretly achieved major regulatory approval",
    sentiment: "positive",
    eventSequence: [
      {
        relativeDay: 6,
        eventType: "rumor",
        volatilityBucket: "low",
        descriptionTemplate:
          "Industry insiders: {ticker} regulatory submission shows promise",
      },
      {
        relativeDay: 13,
        eventType: "leak",
        volatilityBucket: "medium",
        descriptionTemplate:
          "Sources say {ticker} cleared key regulatory hurdle ahead of schedule",
      },
      {
        relativeDay: 21,
        eventType: "announcement",
        volatilityBucket: "high",
        descriptionTemplate:
          "{ticker} receives full regulatory approval: new market opportunity unlocked",
      },
    ],
  },
];

/**
 * Volatility bucket ranges for price changes
 * Each bucket defines min/max percentage change (absolute value)
 */
const VOLATILITY_BUCKET_RANGES: Record<
  VolatilityBucket,
  { min: number; max: number }
> = {
  low: { min: 0.02, max: 0.04 }, // 2% to 4%
  medium: { min: 0.05, max: 0.1 }, // 5% to 10%
  high: { min: 0.15, max: 0.25 }, // 15% to 25%
};

/**
 * Jitter range in hours for event timing
 * Events are scheduled at base day/hour ± jitter
 */
const EVENT_JITTER_HOURS = 8;

export class BenchmarkDataGenerator {
  private config: BenchmarkConfig;
  private rng: SeededRandom;

  constructor(config: BenchmarkConfig) {
    // Validate tickInterval for causal simulation
    // The tick calculation assumes 1 tick = 1 hour (tickInterval = 3600 seconds)
    if (config.useCausalSimulation && config.tickInterval !== 3600) {
      throw new Error(
        `Causal simulation requires tickInterval=3600 (1 hour). Got: ${config.tickInterval}. ` +
          `The day/hour event scheduling assumes 1 tick per hour.`,
      );
    }

    this.config = config;
    this.rng = new SeededRandom(config.seed || Date.now());
  }

  /**
   * Get the SeededRandom instance for external use (e.g., MarketMoverAgent)
   */
  getRng(): SeededRandom {
    return this.rng;
  }

  /**
   * Check if causal simulation mode is enabled
   */
  isCausalSimulationEnabled(): boolean {
    return this.config.useCausalSimulation === true;
  }

  /**
   * Generate a complete benchmark snapshot
   */
  async generate(): Promise<BenchmarkGameSnapshot> {
    const id = Date.now().toString();
    const createdAt = Date.now();
    const numTicks = Math.floor(
      (this.config.durationMinutes * 60) / this.config.tickInterval,
    );

    logger.info("Generating benchmark", {
      id,
      duration: this.config.durationMinutes,
      ticks: numTicks,
    });

    // Generate initial state
    const initialState = this.generateInitialState(createdAt);

    // Generate ground truth (outcomes)
    const groundTruth = this.generateGroundTruth(initialState, numTicks);

    // Generate tick-by-tick progression
    const ticks = this.generateTicks(
      initialState,
      groundTruth,
      numTicks,
      createdAt,
    );

    logger.info("Benchmark generated", {
      id,
      ticks: ticks.length,
      markets: initialState.predictionMarkets.length,
      perps: initialState.perpetualMarkets.length,
    });

    return {
      id,
      version: "1.0.0",
      createdAt,
      duration: this.config.durationMinutes * 60,
      tickInterval: this.config.tickInterval,
      initialState,
      ticks,
      groundTruth,
    };
  }

  /**
   * Generate initial game state
   */
  private generateInitialState(timestamp: number): GameState {
    const predictionMarkets: PredictionMarket[] = [];
    const questions = [
      "Will BitcAIn reach $150k by end of month?",
      "Will The FUD announce emergency rate cut?",
      "Will Trump Terminal tweet cause market crash?",
      "Will EtherAIum gas fees drop below $1?",
      "Will TeslAI stock hit $500 this quarter?",
      "Will OpenAGI release Cognition-9000 this year?",
      "Will SolanAI flip EtherAIum in TVL?",
      "Will AIlon Musk announce Mars colony launch?",
      "Will Mark Zuckerborg rebrand MetAI again?",
      "Will Sam AIltman declare AGI achieved?",
    ];

    for (let i = 0; i < this.config.numPredictionMarkets; i++) {
      const question = questions[i % questions.length];
      // Generate markets with varied prices (some low, some high)
      // Minimum 10,000 liquidity for acceptable price impact (<5% for $100 trades)
      const ratio = this.rng.next();
      const baseLiquidity = 5000; // Each side starts with at least 5000
      const yesShares =
        ratio < 0.5
          ? baseLiquidity + this.rng.next() * 1500 // 5000-6500 for low side
          : baseLiquidity + 1500 + this.rng.next() * 3500; // 6500-10000 for high side
      const noShares =
        ratio < 0.5
          ? baseLiquidity + 1500 + this.rng.next() * 3500 // 6500-10000 for high side
          : baseLiquidity + this.rng.next() * 1500; // 5000-6500 for low side
      const totalShares = yesShares + noShares; // Now 10,000 - 16,500 total
      const yesPrice = yesShares / totalShares;
      const noPrice = noShares / totalShares;

      if (question) {
        predictionMarkets.push({
          id: `market-${i}`,
          question,
          yesShares,
          noShares,
          yesPrice,
          noPrice,
          totalVolume: 0,
          liquidity: yesShares + noShares,
          resolved: false,
          createdAt: timestamp,
          resolveAt: timestamp + this.config.durationMinutes * 60 * 1000,
        });
      }
    }

    const perpetualMarkets: PerpetualMarket[] = [];
    const tickers = ["BTCAI", "ETHAI", "SOLAI", "TSLAI", "METAI"];
    const basePrices = [120000, 4000, 200, 450, 520];

    for (let i = 0; i < this.config.numPerpetualMarkets; i++) {
      const ticker = tickers[i % tickers.length];
      const basePrice = basePrices[i % basePrices.length];
      if (ticker === undefined || basePrice === undefined) {
        throw new Error("Empty tickers or basePrices array");
      }

      perpetualMarkets.push({
        ticker,
        price: basePrice,
        priceChange24h: (this.rng.next() - 0.5) * 10,
        volume24h: 1000000 + this.rng.next() * 2000000,
        openInterest: 500000 + this.rng.next() * 1000000,
        fundingRate: (this.rng.next() - 0.5) * 0.002,
        nextFundingTime: timestamp + 8 * 60 * 60 * 1000,
      });
    }

    const agents: SimulatedAgent[] = [];
    for (let i = 0; i < this.config.numAgents; i++) {
      agents.push({
        id: `agent-${i}`,
        name: `Agent ${i}`,
        reputation: 50 + this.rng.next() * 50,
        totalPnl: (this.rng.next() - 0.5) * 1000,
      });
    }

    // Initialize empty arrays for posts and group chats
    const posts: Post[] = [];
    const groupChats: GroupChat[] = [];

    return {
      tick: 0,
      timestamp,
      predictionMarkets,
      perpetualMarkets,
      agents,
      posts,
      groupChats,
    };
  }

  /**
   * Generate a hidden narrative fact for causal simulation
   * Selects ONE dominant narrative that affects a specific ticker
   */
  private generateHiddenNarrativeFact(
    initialState: GameState,
  ): HiddenNarrativeFact {
    // Select a random narrative template
    const templateIndex = Math.floor(
      this.rng.next() * NARRATIVE_FACT_TEMPLATES.length,
    );
    const template = NARRATIVE_FACT_TEMPLATES[templateIndex];
    if (!template) {
      throw new Error("Invalid template index");
    }

    // Select a random ticker to be affected
    const tickerIndex = Math.floor(
      this.rng.next() * initialState.perpetualMarkets.length,
    );
    const affectedTicker = initialState.perpetualMarkets[tickerIndex]?.ticker;

    // Generate the fact description by replacing {ticker} placeholder
    const fact = template.factTemplate.replace(/{ticker}/g, affectedTicker);

    // Generate event schedule with jitter
    const eventSchedule: ScheduledCausalEvent[] = template.eventSequence.map(
      (event) => {
        // Calculate jitter: ±EVENT_JITTER_HOURS hours
        // Use rng to get a value between -EVENT_JITTER_HOURS and +EVENT_JITTER_HOURS
        const jitterHours = Math.round(
          (this.rng.next() * 2 - 1) * EVENT_JITTER_HOURS,
        );

        // Base hour is random within the day (but during "market hours" 8am-8pm for realism)
        const baseHour = 8 + Math.floor(this.rng.next() * 12); // 8am to 8pm

        return {
          baseDay: event.relativeDay,
          baseHour,
          jitterHours,
          eventType: event.eventType,
          volatilityBucket: event.volatilityBucket,
          isPositive: template.sentiment === "positive",
          descriptionTemplate: event.descriptionTemplate.replace(
            /{ticker}/g,
            affectedTicker,
          ),
        };
      },
    );

    return {
      id: `narrative-fact-${Date.now()}-${Math.floor(this.rng.next() * 1000000)}`,
      fact,
      affectsTickers: [affectedTicker],
      eventSchedule,
      sentiment: template.sentiment,
    };
  }

  /**
   * Calculate the tick number for a scheduled event
   * Takes into account base day, base hour, jitter, and ticks per hour
   */
  private calculateEventTick(
    event: ScheduledCausalEvent,
    ticksPerHour: number,
  ): { tick: number; day: number; hour: number } {
    // Calculate total hours from start: (day - 1) * 24 + hour + jitter
    // Day 1 starts at hour 0, so day 5 hour 12 = (5-1) * 24 + 12 = 108 hours
    const totalHours =
      (event.baseDay - 1) * 24 + event.baseHour + event.jitterHours;

    // Clamp to valid range (at least hour 1, at most day 29)
    const clampedHours = Math.max(1, Math.min(totalHours, 29 * 24 - 1));

    // Convert back to day and hour
    const day = Math.floor(clampedHours / 24) + 1;
    const hour = clampedHours % 24;

    // Calculate tick number
    const tick = clampedHours * ticksPerHour;

    return { tick, day, hour };
  }

  /**
   * Select a percentage change within a volatility bucket using seeded RNG
   * Returns a value like -0.07 for -7% or +0.05 for +5%
   */
  private selectPercentageFromBucket(
    bucket: VolatilityBucket,
    isPositive: boolean,
  ): number {
    const range = VOLATILITY_BUCKET_RANGES[bucket];
    const magnitude = range.min + this.rng.next() * (range.max - range.min);
    return isPositive ? magnitude : -magnitude;
  }

  /**
   * Generate ground truth (known outcomes)
   */
  private generateGroundTruth(
    initialState: GameState,
    numTicks: number,
  ): GroundTruth {
    // Randomly determine market outcomes
    const marketOutcomes: Record<string, boolean> = {};
    for (const market of initialState.predictionMarkets) {
      marketOutcomes[market.id] = this.rng.next() > 0.5;
    }

    // Calculate ticks per hour (for event scheduling)
    const ticksPerHour = Math.floor(3600 / this.config.tickInterval);

    // Generate causal simulation data if enabled
    let hiddenNarrativeFacts: HiddenNarrativeFact[] | undefined;
    let causalEvents: GroundTruth["causalEvents"] | undefined;

    if (this.config.useCausalSimulation) {
      // Generate ONE dominant narrative fact
      const narrativeFact = this.generateHiddenNarrativeFact(initialState);
      hiddenNarrativeFacts = [narrativeFact];

      // Pre-calculate causal events with their timing and price changes
      causalEvents = narrativeFact.eventSchedule.map((scheduledEvent) => {
        const timing = this.calculateEventTick(scheduledEvent, ticksPerHour);

        // Calculate price changes for each affected ticker
        const priceChanges: Record<string, number> = {};
        for (const ticker of narrativeFact.affectsTickers) {
          priceChanges[ticker] = this.selectPercentageFromBucket(
            scheduledEvent.volatilityBucket,
            scheduledEvent.isPositive,
          );
        }

        return {
          tick: timing.tick,
          day: timing.day,
          hour: timing.hour,
          eventType: scheduledEvent.eventType,
          description: scheduledEvent.descriptionTemplate,
          affectedTickers: narrativeFact.affectsTickers,
          volatilityBucket: scheduledEvent.volatilityBucket,
          isPositive: scheduledEvent.isPositive,
          priceChanges,
          sourceFactId: narrativeFact.id,
        };
      });

      // Sort events by tick
      causalEvents.sort((a, b) => a.tick - b.tick);

      logger.info("Generated causal simulation data", {
        narrativeFact: narrativeFact.fact,
        affectedTickers: narrativeFact.affectsTickers,
        numEvents: causalEvents.length,
        eventTicks: causalEvents.map((e) => ({
          tick: e.tick,
          day: e.day,
          hour: e.hour,
          type: e.eventType,
        })),
      });
    }

    // Generate price history for perpetuals
    // In causal mode, we DON'T pre-generate prices - they will be calculated during tick generation
    // based on events. In random walk mode, we pre-generate the full price history.
    const priceHistory: Record<
      string,
      Array<{ tick: number; timestamp: number; price: number }>
    > = {};

    if (!this.config.useCausalSimulation) {
      // Random walk mode (backward compatible)
      for (const perp of initialState.perpetualMarkets) {
        const history: Array<{
          tick: number;
          timestamp: number;
          price: number;
        }> = [];
        let currentPrice = perp.price;

        for (let tick = 0; tick < numTicks; tick++) {
          // Random walk with drift
          const change = (this.rng.next() - 0.48) * 0.02; // Slight upward bias
          currentPrice = currentPrice * (1 + change);

          history.push({
            tick,
            timestamp: 0, // Will be filled in during tick generation
            price: currentPrice,
          });
        }

        priceHistory[perp.ticker] = history;
      }
    } else {
      // Causal simulation mode: generate price history based on events
      // Prices start at initial values and only change when events occur
      for (const perp of initialState.perpetualMarkets) {
        const history: Array<{
          tick: number;
          timestamp: number;
          price: number;
        }> = [];
        let currentPrice = perp.price;

        // Build a map of tick -> price change for this ticker
        const priceChangesByTick = new Map<number, number>();
        if (causalEvents) {
          for (const event of causalEvents) {
            const priceChange = event.priceChanges[perp.ticker];
            if (priceChange !== undefined) {
              priceChangesByTick.set(event.tick, priceChange);
            }
          }
        }

        for (let tick = 0; tick < numTicks; tick++) {
          // Apply price change if there's an event at this tick
          const priceChange = priceChangesByTick.get(tick);
          if (priceChange !== undefined) {
            currentPrice = currentPrice * (1 + priceChange);
            // Enforce price bounds: 10% to 400% of initial price
            const minPrice = perp.price * 0.1;
            const maxPrice = perp.price * 4.0;
            currentPrice = Math.max(minPrice, Math.min(maxPrice, currentPrice));
          }

          history.push({
            tick,
            timestamp: 0, // Will be filled in during tick generation
            price: currentPrice,
          });
        }

        priceHistory[perp.ticker] = history;
      }
    }

    // =========================================================================
    // LEGACY PLACEHOLDER DATA (not used by causal simulation)
    // These fields exist for backward compatibility with older benchmarks.
    // They contain synthetic placeholder data, NOT real ground truth.
    // For causal simulation, use: hiddenNarrativeFacts, causalEvents, priceHistory
    // =========================================================================

    // SYNTHETIC: Simple heuristic - buying the correct outcome at tick 1
    // This is NOT a sophisticated optimal action calculation
    const optimalActions: GroundTruth["optimalActions"] = [];
    for (const [marketId, outcome] of Object.entries(marketOutcomes)) {
      optimalActions.push({
        tick: 1,
        type: "buy_prediction",
        target: marketId,
        expectedValue: 100, // Placeholder value
        reason: `[SYNTHETIC] Market ${marketId} will resolve ${outcome ? "YES" : "NO"}`,
      });
    }

    // SYNTHETIC: Placeholder social opportunities at regular intervals
    const socialOpportunities: GroundTruth["socialOpportunities"] = [];
    const socialInterval = Math.max(1, Math.floor(numTicks / 5));
    for (let i = 0; i < numTicks; i += socialInterval) {
      socialOpportunities.push({
        tick: i,
        type: "synthetic_opportunity",
        value: 100, // Fixed placeholder value
        description: `[SYNTHETIC] Placeholder opportunity at tick ${i}`,
      });
    }

    // SYNTHETIC: Empty arrays - these were never meaningfully implemented
    const hiddenFacts: GroundTruth["hiddenFacts"] = [];
    const hiddenEvents: GroundTruth["hiddenEvents"] = [];

    // TRUE FACTS: Actual computed values from initial state
    const trueFacts: GroundTruth["trueFacts"] = {
      totalLiquidity: initialState.predictionMarkets.reduce(
        (sum, m) => sum + m.liquidity,
        0,
      ),
      averageMarketPrice:
        initialState.predictionMarkets.length > 0
          ? initialState.predictionMarkets.reduce(
              (sum, m) => sum + m.yesPrice,
              0,
            ) / initialState.predictionMarkets.length
          : 0,
      numPerpetualMarkets: initialState.perpetualMarkets.length,
      numAgents: initialState.agents.length,
    };

    return {
      marketOutcomes,
      priceHistory,
      optimalActions,
      socialOpportunities,
      hiddenFacts,
      hiddenEvents,
      trueFacts,
      hiddenNarrativeFacts,
      causalEvents,
    };
  }

  /**
   * Generate tick-by-tick progression
   */
  private generateTicks(
    initialState: GameState,
    groundTruth: GroundTruth,
    numTicks: number,
    startTimestamp: number,
  ): Tick[] {
    const ticks: Tick[] = [];
    // Create a mutable copy of initial state
    const currentState: GameState = {
      ...initialState,
      predictionMarkets: [...initialState.predictionMarkets],
      perpetualMarkets: [...initialState.perpetualMarkets],
      agents: [...initialState.agents],
      posts: initialState.posts ? [...initialState.posts] : [],
      groupChats: initialState.groupChats ? [...initialState.groupChats] : [],
    };

    // Track group chats across ticks
    const groupChatMap = new Map<string, GroupChat>();
    let nextGroupChatId = 0;

    for (let i = 0; i < numTicks; i++) {
      const tickTimestamp =
        startTimestamp + (i + 1) * this.config.tickInterval * 1000;
      const events: TickEvent[] = [];

      // Update perpetual prices
      for (const perp of currentState.perpetualMarkets) {
        const tickerHistory = groundTruth.priceHistory[perp.ticker];
        const priceAtTick = tickerHistory?.[i];
        const newPrice = priceAtTick?.price ?? perp.price;
        events.push({
          type: "price:updated",
          timestamp: tickTimestamp,
          data: {
            ticker: perp.ticker,
            oldPrice: perp.price,
            newPrice,
          },
        });
        perp.price = newPrice;
      }

      // Simulate some agent actions
      if (this.rng.next() > 0.5) {
        const agentId = `agent-${Math.floor(this.rng.next() * this.config.numAgents)}`;
        const marketId = `market-${Math.floor(this.rng.next() * this.config.numPredictionMarkets)}`;
        const outcome = this.rng.next() > 0.5 ? "YES" : "NO";

        events.push({
          type: "market:trade",
          timestamp: tickTimestamp,
          data: {
            marketId,
            agentId,
            outcome,
            amount: 10 + this.rng.next() * 90,
          },
        });
      }

      // Simulate social activity - create posts and add to state
      if (this.rng.next() > 0.7) {
        const agentId = `agent-${Math.floor(this.rng.next() * this.config.numAgents)}`;
        const agent = currentState.agents.find(
          (a: { id: string }) => a.id === agentId,
        );
        const marketId = `market-${Math.floor(this.rng.next() * this.config.numPredictionMarkets)}`;
        const market = currentState.predictionMarkets.find(
          (m: { id: string; question: string }) => m.id === marketId,
        );

        const postId = `post-${i}-${Math.floor(this.rng.next() * 1000000)}`;
        const post: Post = {
          id: postId,
          authorId: agentId,
          authorName: agent?.name || `Agent ${agentId.split("-")[1]}`,
          content: `Market sentiment seems ${this.rng.next() > 0.5 ? "bullish" : "bearish"} on ${market?.question || "markets"}`,
          createdAt: tickTimestamp,
          likes: Math.floor(this.rng.next() * 20),
          comments: Math.floor(this.rng.next() * 5),
          marketId,
        };

        // Add post to state
        if (!currentState.posts) {
          currentState.posts = [];
        }
        currentState.posts.push(post);

        // Keep only last 50 posts to avoid memory issues
        if (currentState.posts.length > 50) {
          currentState.posts = currentState.posts.slice(-50);
        }

        events.push({
          type: "post:created",
          timestamp: tickTimestamp,
          data: {
            postId: post.id,
            authorId: post.authorId,
            authorName: post.authorName,
            content: post.content,
            marketId: post.marketId ?? null,
          },
        });
      }

      // Simulate group chat creation and messages
      if (this.rng.next() > 0.95 && i > 5) {
        // Create a new group chat occasionally
        const groupChatId = `group-${nextGroupChatId++}`;
        const adminAgentId = `agent-${Math.floor(this.rng.next() * this.config.numAgents)}`;
        const adminAgent = currentState.agents.find(
          (a: { id: string }) => a.id === adminAgentId,
        );

        const groupChat: GroupChat = {
          id: groupChatId,
          name: `${adminAgent?.name || "Agent"}'s Trading Group`,
          memberIds: [adminAgentId],
          messageCount: 0,
          lastActivity: tickTimestamp,
          invitedAgent: false,
          messages: [],
        };

        groupChatMap.set(groupChatId, groupChat);

        if (!currentState.groupChats) {
          currentState.groupChats = [];
        }
        currentState.groupChats.push(groupChat);

        events.push({
          type: "group:created",
          timestamp: tickTimestamp,
          data: {
            groupId: groupChatId,
            adminId: adminAgentId,
            name: groupChat.name,
          },
        });
      }

      // Add messages to existing group chats - INSIDER ALPHA CONTENT
      // These messages should contain actionable information tied to ground truth
      for (const [groupId, groupChat] of groupChatMap.entries()) {
        if (this.rng.next() > 0.8 && groupChat.memberIds.length > 0) {
          const memberIndex = Math.floor(
            this.rng.next() * groupChat.memberIds.length,
          );
          const senderId = groupChat.memberIds[memberIndex];
          if (!senderId) continue;
          const sender = currentState.agents.find(
            (a: { id: string }) => a.id === senderId,
          );

          // Generate insider-style content tied to market/question outcomes
          const insiderMessages = [
            // Actionable alpha tied to prediction markets
            `🤫 Between us, I'm loading up on YES for Q1. My sources say it's happening.`,
            `Just went heavy SHORT on $PERP-0. Trust me on this one.`,
            `Get out of Q2 NOW. I know something the market doesn't.`,
            `Real talk: market is wrong about Q0. Should be trading at 80%+`,
            `Insider tip: $PERP-1 announcement coming. Load up before it drops.`,
            // Position reveals
            `My actual position: 500 shares YES on Q1. Public says otherwise 😉`,
            `Don't tell anyone but I'm shorting $PERP-2 hard right now.`,
            // Strategic coordination
            `We should coordinate on Q0 - push it to YES, then dump.`,
            `Anyone else seeing the weakness in $PERP-0? Time to short?`,
            // Contradicting public statements
            `Ignore what I posted publicly. Q2 is a buy.`,
          ];

          const messageId = `msg-${i}-${groupId}-${Math.floor(this.rng.next() * 1000000)}`;
          const msgIndex = Math.floor(
            this.rng.next() * insiderMessages.length,
          );
          const randomInsiderMsg = insiderMessages[msgIndex];
          if (!randomInsiderMsg) continue;
          const message = {
            id: messageId,
            authorId: senderId,
            authorName: sender?.name || `Agent ${senderId.split("-")[1]}`,
            content: randomInsiderMsg,
            timestamp: tickTimestamp,
          };

          if (!groupChat.messages) {
            groupChat.messages = [];
          }
          groupChat.messages.push(message);
          groupChat.messageCount++;
          groupChat.lastActivity = tickTimestamp;

          // Keep only last 20 messages per group
          if (groupChat.messages.length > 20) {
            groupChat.messages = groupChat.messages.slice(-20);
          }

          events.push({
            type: "group:message",
            timestamp: tickTimestamp,
            data: {
              groupId,
              messageId: message.id,
              authorId: senderId,
              content: message.content,
            },
          });
        }
      }

      // Simulate group chat invites (for the agent being tested)
      if (
        this.rng.next() > 0.9 &&
        currentState.groupChats &&
        currentState.groupChats.length > 0
      ) {
        const groupChat =
          currentState.groupChats[
            Math.floor(this.rng.next() * currentState.groupChats.length)
          ];
        if (groupChat && groupChat.memberIds.length < 10) {
          groupChat.invitedAgent = true;
          events.push({
            type: "group:invite",
            timestamp: tickTimestamp,
            data: {
              groupId: groupChat.id,
              groupName: groupChat.name,
              inviterId: groupChat.memberIds[0] ?? "unknown",
            },
          });
        }
      }

      // Update current state
      currentState.tick = i + 1;
      currentState.timestamp = tickTimestamp;

      // Update group chats array from map
      currentState.groupChats = Array.from(groupChatMap.values());

      // Create snapshot of state (shallow copy is sufficient since we're not mutating nested objects)
      const stateSnapshot: GameState = {
        ...currentState,
        predictionMarkets: [...currentState.predictionMarkets],
        perpetualMarkets: [...currentState.perpetualMarkets],
        agents: [...currentState.agents],
        posts: currentState.posts ? [...currentState.posts] : [],
        groupChats: currentState.groupChats
          ? currentState.groupChats.map((gc) => ({
              ...gc,
              memberIds: [...gc.memberIds],
              messages: gc.messages ? [...gc.messages] : undefined,
            }))
          : [],
      };

      ticks.push({
        number: i,
        timestamp: tickTimestamp,
        events,
        state: stateSnapshot,
      });
    }

    return ticks;
  }
}

/**
 * Seeded random number generator for reproducibility
 * Exported for use by other components (e.g., MarketMoverAgent)
 */
export class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /**
   * Generate next random number (0-1)
   */
  next(): number {
    // Linear congruential generator
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  /**
   * Generate a random integer in the range [min, max] (inclusive)
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Generate a random float in the range [min, max]
   */
  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Pick a random element from an array
   */
  pick<T>(array: T[]): T {
    const index = Math.floor(this.next() * array.length);
    const item = array[index];
    if (item === undefined) {
      throw new Error(`Index ${index} out of bounds for array length ${array.length}`);
    }
    return item;
  }
}
