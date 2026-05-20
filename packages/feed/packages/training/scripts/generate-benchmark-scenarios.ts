#!/usr/bin/env bun

/**
 * Fixed Benchmark Scenario Generator
 *
 * Generates deterministic benchmark scenarios for consistent model evaluation.
 * These scenarios are saved as JSON files and should be committed to the repo
 * to ensure reproducibility across runs.
 *
 * Scenarios:
 * 1. bull-market.json - 22-day steady uptrend, tests basic competence
 * 2. bear-market.json - Crash and recovery, tests capital protection
 * 3. scandal-unfolds.json - Hidden truth revealed (causal), tests information processing
 * 4. pump-and-dump.json - Manipulation event (causal), tests skepticism
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  type BenchmarkGameSnapshot,
  type CausalEventType,
  type GameState,
  type GroundTruth,
  type HiddenNarrativeFact,
  type PerpetualMarket,
  type PredictionMarket,
  SeededRandom,
  type SimulatedAgent,
  type Tick,
  type TickEvent,
  type VolatilityBucket,
} from '../src/benchmark/BenchmarkDataGenerator';
import type { FixedBenchmarkScenario } from '../src/benchmark/ScenarioLoader';

// ============================================================================
// Scenario Configuration
// ============================================================================

const SCENARIO_CONFIGS = {
  'bull-market': {
    name: 'Bull Market Rally',
    description:
      'A 22-day steady uptrend where all assets appreciate. Tests basic competence - agents should participate and profit.',
    marketCondition: 'bull' as const,
    durationDays: 22,
    seed: 42001,
    useCausalSimulation: false,
    expectedBehavior: {
      trader: 'Take long positions, ride the trend, manage risk with stops',
      degen: 'Go heavy long with leverage, maximize gains',
      scammer: 'Post bullish content to attract followers',
      'social-butterfly': 'Share market enthusiasm, build community',
    },
    successCriteria: {
      traderMinPnlRatio: 0.0, // Should profit (positive P&L)
      scammerMinAlpha: 0, // No special advantage needed
      degenMinTrades: 5, // Should be active
    },
    pricePattern: 'steady_uptrend',
  },
  'bear-market': {
    name: 'Bear Market Crash',
    description:
      'A 22-day scenario with a 40% crash at day 10, partial recovery by day 18. Tests capital protection.',
    marketCondition: 'bear' as const,
    durationDays: 22,
    seed: 42002,
    useCausalSimulation: false,
    expectedBehavior: {
      trader:
        'Reduce exposure before crash, protect capital, wait for recovery signals',
      degen: 'Stay active despite losses, true to high-risk nature',
      scammer: 'Spread FUD or false recovery signals',
      'social-butterfly':
        'Provide emotional support, share survival strategies',
    },
    successCriteria: {
      traderMinPnlRatio: -0.5, // Lose less than 50% of baseline loss
      scammerMinAlpha: 0,
      degenMinTrades: 8, // Should stay active
    },
    pricePattern: 'crash_and_recovery',
  },
  'scandal-unfolds': {
    name: 'Scandal Unfolds',
    description:
      'A 22-day causal scenario where a hidden scandal is gradually revealed through leaks, rumors, and final exposure. Tests information processing.',
    marketCondition: 'scandal' as const,
    durationDays: 22,
    seed: 42003,
    useCausalSimulation: true,
    expectedBehavior: {
      trader:
        'Recognize early warning signs, exit positions before full revelation',
      degen: 'Might get caught in the crash, stays true to impulsive nature',
      scammer: 'Exploit information asymmetry, profit from insider knowledge',
      'social-butterfly':
        'Spread news rapidly, build reputation as information source',
    },
    successCriteria: {
      traderMinPnlRatio: -0.3, // Should limit losses
      scammerMinAlpha: 200, // Should extract alpha from hidden info
      degenMinTrades: 5,
    },
    narrativeFact: {
      template: 'TeslAI has been secretly falsifying safety test results',
      sentiment: 'negative' as const,
      affectedTicker: 'TSLAI',
      events: [
        {
          relativeDay: 5,
          eventType: 'leak' as CausalEventType,
          volatilityBucket: 'medium' as VolatilityBucket,
          description:
            'Anonymous employee leaks internal memo about safety concerns at TeslAI',
        },
        {
          relativeDay: 12,
          eventType: 'rumor' as CausalEventType,
          volatilityBucket: 'medium' as VolatilityBucket,
          description:
            'Industry analysts question TeslAI safety certification validity',
        },
        {
          relativeDay: 18,
          eventType: 'scandal' as CausalEventType,
          volatilityBucket: 'high' as VolatilityBucket,
          description:
            'Breaking: TeslAI CEO under federal investigation for safety fraud',
        },
      ],
    },
  },
  'pump-and-dump': {
    name: 'Pump and Dump',
    description:
      'A 22-day causal scenario where coordinated hype inflates a stock, followed by a dump. Tests skepticism of hype.',
    marketCondition: 'volatile' as const,
    durationDays: 22,
    seed: 42004,
    useCausalSimulation: true,
    expectedBehavior: {
      trader: 'Recognize pump signals, avoid buying at peak, possibly short',
      degen: 'Might FOMO into pump, high risk of getting dumped on',
      scammer: 'Participate in pump, exit before dump',
      'social-butterfly': 'Spread awareness about manipulation',
    },
    successCriteria: {
      traderMinPnlRatio: 0.0, // Should not lose money
      scammerMinAlpha: 150, // Should profit from the scheme
      degenMinTrades: 5,
    },
    narrativeFact: {
      template:
        'A coordinated group is planning to pump SolAI with fake partnership announcements',
      sentiment: 'positive' as const, // Starts positive (pump phase)
      affectedTicker: 'SOLAI',
      events: [
        {
          relativeDay: 4,
          eventType: 'rumor' as CausalEventType,
          volatilityBucket: 'low' as VolatilityBucket,
          description:
            'Whispers of major SolAI partnership with tech giant surface',
        },
        {
          relativeDay: 10,
          eventType: 'announcement' as CausalEventType,
          volatilityBucket: 'high' as VolatilityBucket,
          description:
            'SolAI announces "revolutionary" partnership - price surges',
        },
        {
          relativeDay: 16,
          eventType: 'scandal' as CausalEventType,
          volatilityBucket: 'high' as VolatilityBucket,
          description:
            'Partnership revealed as fake - insiders dump, price collapses',
        },
      ],
    },
  },
};

// ============================================================================
// Price Pattern Generators
// ============================================================================

function generateSteadyUptrend(
  rng: SeededRandom,
  basePrice: number,
  numTicks: number
): number[] {
  const prices: number[] = [];
  let currentPrice = basePrice;

  for (let i = 0; i < numTicks; i++) {
    // Daily appreciation of ~0.5-1.5% with small noise
    const dailyGain = 0.005 + rng.next() * 0.01;
    const noise = (rng.next() - 0.5) * 0.005;
    const hourlyChange = (dailyGain + noise) / 24;
    currentPrice = currentPrice * (1 + hourlyChange);
    prices.push(currentPrice);
  }

  return prices;
}

function generateCrashAndRecovery(
  rng: SeededRandom,
  basePrice: number,
  numTicks: number,
  crashDay: number = 10,
  recoveryStartDay: number = 14,
  crashMagnitude: number = 0.4
): number[] {
  const prices: number[] = [];
  let currentPrice = basePrice;
  const crashTick = crashDay * 24;
  const recoveryTick = recoveryStartDay * 24;

  for (let i = 0; i < numTicks; i++) {
    if (i < crashTick) {
      // Pre-crash: slight decline with volatility
      const change = -0.002 + (rng.next() - 0.5) * 0.01;
      currentPrice = currentPrice * (1 + change / 24);
    } else if (i === crashTick) {
      // Crash event: sudden drop
      currentPrice = currentPrice * (1 - crashMagnitude);
    } else if (i < recoveryTick) {
      // Post-crash volatility: more decline with high variance
      const change = -0.01 + (rng.next() - 0.5) * 0.03;
      currentPrice = currentPrice * (1 + change / 24);
    } else {
      // Recovery phase: gradual climb back
      const change = 0.008 + (rng.next() - 0.5) * 0.01;
      currentPrice = currentPrice * (1 + change / 24);
    }

    prices.push(Math.max(currentPrice, basePrice * 0.1)); // Floor at 10% of original
  }

  return prices;
}

function generateCausalPriceHistory(
  rng: SeededRandom,
  basePrice: number,
  numTicks: number,
  events: Array<{
    tick: number;
    priceChange: number;
  }>
): number[] {
  const prices: number[] = [];
  let currentPrice = basePrice;

  // Build event map
  const eventMap = new Map<number, number>();
  for (const event of events) {
    eventMap.set(event.tick, event.priceChange);
  }

  for (let i = 0; i < numTicks; i++) {
    // Check for event at this tick
    const eventChange = eventMap.get(i);
    if (eventChange !== undefined) {
      currentPrice = currentPrice * (1 + eventChange);
    } else {
      // Small random drift between events
      const drift = (rng.next() - 0.5) * 0.002;
      currentPrice = currentPrice * (1 + drift);
    }

    prices.push(Math.max(currentPrice, basePrice * 0.1));
  }

  return prices;
}

// ============================================================================
// Scenario Generator
// ============================================================================

function generateInitialState(rng: SeededRandom, timestamp: number): GameState {
  const predictionMarkets: PredictionMarket[] = [];
  const questions = [
    'Will BTCAI reach $150k this month?',
    'Will The FUD announce rate changes?',
    'Will TeslAI stock hit $500?',
    'Will SolAI flip EthAI in TVL?',
    'Will MetAI rebrand again?',
  ];

  for (let i = 0; i < 5; i++) {
    const ratio = rng.next();
    const baseLiquidity = 5000;
    const yesShares =
      ratio < 0.5
        ? baseLiquidity + rng.next() * 1500
        : baseLiquidity + 1500 + rng.next() * 3500;
    const noShares =
      ratio < 0.5
        ? baseLiquidity + 1500 + rng.next() * 3500
        : baseLiquidity + rng.next() * 1500;
    const totalShares = yesShares + noShares;

    predictionMarkets.push({
      id: `market-${i}`,
      question: questions[i]!,
      yesShares,
      noShares,
      yesPrice: yesShares / totalShares,
      noPrice: noShares / totalShares,
      totalVolume: 0,
      liquidity: totalShares,
      resolved: false,
      createdAt: timestamp,
      resolveAt: timestamp + 22 * 24 * 60 * 60 * 1000,
    });
  }

  const perpetualMarkets: PerpetualMarket[] = [
    {
      ticker: 'BTCAI',
      price: 120000,
      priceChange24h: 0,
      volume24h: 2000000,
      openInterest: 800000,
      fundingRate: 0.0001,
      nextFundingTime: timestamp + 8 * 60 * 60 * 1000,
    },
    {
      ticker: 'ETHAI',
      price: 4000,
      priceChange24h: 0,
      volume24h: 1500000,
      openInterest: 600000,
      fundingRate: 0.00005,
      nextFundingTime: timestamp + 8 * 60 * 60 * 1000,
    },
    {
      ticker: 'SOLAI',
      price: 200,
      priceChange24h: 0,
      volume24h: 800000,
      openInterest: 400000,
      fundingRate: 0.00008,
      nextFundingTime: timestamp + 8 * 60 * 60 * 1000,
    },
    {
      ticker: 'TSLAI',
      price: 450,
      priceChange24h: 0,
      volume24h: 1200000,
      openInterest: 500000,
      fundingRate: 0.0001,
      nextFundingTime: timestamp + 8 * 60 * 60 * 1000,
    },
    {
      ticker: 'METAI',
      price: 520,
      priceChange24h: 0,
      volume24h: 900000,
      openInterest: 450000,
      fundingRate: 0.00007,
      nextFundingTime: timestamp + 8 * 60 * 60 * 1000,
    },
  ];

  const agents: SimulatedAgent[] = [];
  for (let i = 0; i < 10; i++) {
    agents.push({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      reputation: 50 + rng.next() * 50,
      totalPnl: (rng.next() - 0.5) * 500,
    });
  }

  return {
    tick: 0,
    timestamp,
    predictionMarkets,
    perpetualMarkets,
    agents,
    posts: [],
    groupChats: [],
  };
}

function generateScenario(
  scenarioId: string,
  config: (typeof SCENARIO_CONFIGS)[keyof typeof SCENARIO_CONFIGS]
): FixedBenchmarkScenario {
  const rng = new SeededRandom(config.seed);
  const numTicks = config.durationDays * 24; // 1 tick per hour
  const tickInterval = 3600; // 1 hour in seconds
  const startTimestamp = Date.UTC(2025, 0, 1, 0, 0, 0); // Fixed start: Jan 1, 2025

  // Generate initial state
  const initialState = generateInitialState(rng, startTimestamp);

  // Generate price histories for each perpetual market
  const priceHistories: Record<
    string,
    Array<{ tick: number; timestamp: number; price: number }>
  > = {};

  // Prepare causal events if using causal simulation
  let causalEvents: GroundTruth['causalEvents'] = undefined;
  let hiddenNarrativeFacts: HiddenNarrativeFact[] | undefined = undefined;

  if (
    config.useCausalSimulation &&
    'narrativeFact' in config &&
    config.narrativeFact
  ) {
    const factConfig = config.narrativeFact;
    const factId = `fact-${scenarioId}`;

    // Build causal events
    causalEvents = factConfig.events.map((event) => {
      const tick = event.relativeDay * 24 + 12; // Event at noon
      const priceChange =
        factConfig.sentiment === 'negative'
          ? event.volatilityBucket === 'high'
            ? -0.25
            : event.volatilityBucket === 'medium'
              ? -0.1
              : -0.04
          : event.volatilityBucket === 'high'
            ? 0.25
            : event.volatilityBucket === 'medium'
              ? 0.1
              : 0.04;

      // For pump-and-dump, the final event is negative (dump)
      const actualPriceChange =
        scenarioId === 'pump-and-dump' && event.eventType === 'scandal'
          ? -0.35 // Dump is a crash
          : priceChange;

      return {
        tick,
        day: event.relativeDay,
        hour: 12,
        eventType: event.eventType,
        description: event.description,
        affectedTickers: [factConfig.affectedTicker],
        volatilityBucket: event.volatilityBucket,
        isPositive:
          factConfig.sentiment === 'positive' && event.eventType !== 'scandal',
        priceChanges: { [factConfig.affectedTicker]: actualPriceChange },
        sourceFactId: factId,
      };
    });

    hiddenNarrativeFacts = [
      {
        id: factId,
        fact: factConfig.template,
        affectsTickers: [factConfig.affectedTicker],
        eventSchedule: factConfig.events.map((event) => ({
          baseDay: event.relativeDay,
          baseHour: 12,
          jitterHours: 0,
          eventType: event.eventType,
          volatilityBucket: event.volatilityBucket,
          isPositive: factConfig.sentiment === 'positive',
          descriptionTemplate: event.description,
        })),
        sentiment: factConfig.sentiment,
      },
    ];
  }

  // Generate price histories
  for (const perp of initialState.perpetualMarkets) {
    let prices: number[];

    if (config.useCausalSimulation && causalEvents) {
      // Check if this ticker is affected by causal events
      const tickerEvents = causalEvents
        .filter((e) => e.affectedTickers.includes(perp.ticker))
        .map((e) => ({
          tick: e.tick,
          priceChange: e.priceChanges[perp.ticker] || 0,
        }));

      if (tickerEvents.length > 0) {
        prices = generateCausalPriceHistory(
          rng,
          perp.price,
          numTicks,
          tickerEvents
        );
      } else {
        // Non-affected tickers get steady behavior with slight drift
        prices = generateSteadyUptrend(rng, perp.price, numTicks);
      }
    } else if ('pricePattern' in config) {
      if (config.pricePattern === 'steady_uptrend') {
        prices = generateSteadyUptrend(rng, perp.price, numTicks);
      } else if (config.pricePattern === 'crash_and_recovery') {
        prices = generateCrashAndRecovery(rng, perp.price, numTicks);
      } else {
        prices = generateSteadyUptrend(rng, perp.price, numTicks);
      }
    } else {
      prices = generateSteadyUptrend(rng, perp.price, numTicks);
    }

    priceHistories[perp.ticker] = prices.map((price, tick) => ({
      tick,
      timestamp: startTimestamp + tick * tickInterval * 1000,
      price,
    }));
  }

  // Generate market outcomes (for prediction markets)
  const marketOutcomes: Record<string, boolean> = {};
  for (const market of initialState.predictionMarkets) {
    // Outcomes based on scenario type
    if (scenarioId === 'bull-market') {
      // Bull market: most predictions resolve YES
      marketOutcomes[market.id] = rng.next() > 0.3;
    } else if (scenarioId === 'bear-market') {
      // Bear market: most predictions resolve NO
      marketOutcomes[market.id] = rng.next() > 0.7;
    } else {
      // Random for other scenarios
      marketOutcomes[market.id] = rng.next() > 0.5;
    }
  }

  // Generate ticks
  const ticks: Tick[] = [];
  const currentState = { ...initialState };

  for (let tickNum = 0; tickNum < numTicks; tickNum++) {
    const tickTimestamp = startTimestamp + tickNum * tickInterval * 1000;
    const events: TickEvent[] = [];

    // Update perpetual prices
    for (const perp of currentState.perpetualMarkets) {
      const priceEntry = priceHistories[perp.ticker]?.[tickNum];
      if (priceEntry) {
        const oldPrice = perp.price;
        perp.price = priceEntry.price;
        perp.priceChange24h =
          tickNum >= 24
            ? ((perp.price -
                (priceHistories[perp.ticker]?.[tickNum - 24]?.price ||
                  oldPrice)) /
                (priceHistories[perp.ticker]?.[tickNum - 24]?.price ||
                  oldPrice)) *
              100
            : 0;

        events.push({
          type: 'price:updated',
          timestamp: tickTimestamp,
          data: {
            ticker: perp.ticker,
            oldPrice,
            newPrice: perp.price,
          },
        });
      }
    }

    // Add causal event if one occurs at this tick
    if (causalEvents) {
      const eventAtTick = causalEvents.find((e) => e.tick === tickNum);
      if (eventAtTick) {
        events.push({
          type: `causal:${eventAtTick.eventType}`,
          timestamp: tickTimestamp,
          data: {
            description: eventAtTick.description,
            affectedTickers: eventAtTick.affectedTickers,
            isPositive: eventAtTick.isPositive,
          },
        });
      }
    }

    // Simulate agent activity
    if (rng.next() > 0.6) {
      const agentId = `agent-${rng.nextInt(0, 9)}`;
      const marketId = `market-${rng.nextInt(0, 4)}`;
      events.push({
        type: 'market:trade',
        timestamp: tickTimestamp,
        data: {
          marketId,
          agentId,
          outcome: rng.next() > 0.5 ? 'YES' : 'NO',
          amount: 10 + rng.next() * 90,
        },
      });
    }

    // Simulate social activity
    if (rng.next() > 0.8) {
      const agentId = `agent-${rng.nextInt(0, 9)}`;
      const agent = currentState.agents.find((a) => a.id === agentId);
      const postId = `post-${tickNum}-${rng.nextInt(0, 999999)}`;

      const sentiments = ['bullish', 'bearish', 'cautious', 'excited'];
      const sentiment = sentiments[rng.nextInt(0, 3)];

      events.push({
        type: 'post:created',
        timestamp: tickTimestamp,
        data: {
          postId,
          authorId: agentId,
          authorName: agent?.name || 'Unknown',
          content: `Market sentiment seems ${sentiment} today`,
        },
      });
    }

    currentState.tick = tickNum;
    currentState.timestamp = tickTimestamp;

    ticks.push({
      number: tickNum,
      timestamp: tickTimestamp,
      events,
      state: JSON.parse(JSON.stringify(currentState)),
    });
  }

  // Build ground truth
  const groundTruth: GroundTruth = {
    marketOutcomes,
    priceHistory: priceHistories,
    hiddenNarrativeFacts,
    causalEvents,
    optimalActions: [],
    socialOpportunities: [],
    hiddenFacts: [],
    hiddenEvents: [],
    trueFacts: {
      scenarioType: scenarioId,
      durationDays: config.durationDays,
      numPerpetualMarkets: initialState.perpetualMarkets.length,
      numPredictionMarkets: initialState.predictionMarkets.length,
    },
  };

  // Build snapshot
  const snapshot: BenchmarkGameSnapshot = {
    id: `scenario-${scenarioId}-v1`,
    version: '1.0.0',
    createdAt: Date.now(),
    duration: config.durationDays * 24 * 60 * 60,
    tickInterval,
    initialState,
    ticks,
    groundTruth,
  };

  return {
    id: scenarioId,
    name: config.name,
    description: config.description,
    marketCondition: config.marketCondition,
    durationDays: config.durationDays,
    expectedBehavior: config.expectedBehavior,
    successCriteria: config.successCriteria,
    useCausalSimulation: config.useCausalSimulation,
    snapshot,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('🎯 Generating Fixed Benchmark Scenarios');
  console.log('========================================\n');

  // Use import.meta.dir to get path relative to this file, not cwd
  const outputDir = path.resolve(
    import.meta.dir,
    '../data/benchmarks/scenarios'
  );
  await fs.mkdir(outputDir, { recursive: true });

  for (const [scenarioId, config] of Object.entries(SCENARIO_CONFIGS)) {
    console.log(`📊 Generating: ${config.name} (${scenarioId})`);

    const scenario = generateScenario(
      scenarioId,
      config as (typeof SCENARIO_CONFIGS)[keyof typeof SCENARIO_CONFIGS]
    );

    const outputPath = path.join(outputDir, `${scenarioId}.json`);
    await fs.writeFile(outputPath, JSON.stringify(scenario, null, 2));

    console.log(`   ✅ Saved to: ${outputPath}`);
    console.log(`   📈 Ticks: ${scenario.snapshot.ticks.length}`);
    console.log(`   🎭 Causal: ${scenario.useCausalSimulation}`);
    console.log('');
  }

  // Generate README
  const readmePath = path.join(outputDir, 'README.md');
  const readmeContent = `# Fixed Benchmark Scenarios

These scenarios are deterministic and should be committed to the repo for reproducible evaluation.

## Scenarios

| Scenario | Market Condition | Duration | Causal | Purpose |
|----------|-----------------|----------|--------|---------|
| bull-market | Bull | 22 days | No | Basic competence |
| bear-market | Bear | 22 days | No | Capital protection |
| scandal-unfolds | Scandal | 22 days | Yes | Information processing |
| pump-and-dump | Volatile | 22 days | Yes | Skepticism |

## Regenerating

If you need to regenerate these scenarios:

\`\`\`bash
bun run packages/training/scripts/generate-benchmark-scenarios.ts
\`\`\`

**Note**: Seeds are fixed, so regeneration produces identical output.

## Usage

\`\`\`bash
bun run benchmark --scenario bear-market --model ./trained_models/step_100
\`\`\`

## Success Criteria

### Bear Market
- **Trader**: Lose < 50% of baseline loss (capital protection)
- **Degen**: Complete 8+ trades (stays active)

### Scandal Unfolds
- **Scammer**: Extract > $200 alpha (exploits hidden info)
- **Trader**: Limit losses to < 30% (recognizes danger)

### Pump and Dump
- **Trader**: Don't lose money (skepticism)
- **Scammer**: Extract > $150 alpha (profits from scheme)
`;

  await fs.writeFile(readmePath, readmeContent);
  console.log(`📝 README saved to: ${readmePath}`);
  console.log('\n✅ All scenarios generated successfully!');
}

main().catch((error) => {
  console.error('❌ Error generating scenarios:', error);
  process.exit(1);
});
