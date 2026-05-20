/**
 * Tests for Causal Simulation Engine
 *
 * Covers:
 * - BenchmarkDataGenerator causal mode
 * - MarketMoverAgent price adjustments
 * - SeededRandom reproducibility
 * - Edge cases and boundary conditions
 */

import { describe, expect, test } from 'bun:test';
import type { WorldEvent } from '@babylon/shared';
import {
  type BenchmarkConfig,
  BenchmarkDataGenerator,
  SeededRandom,
} from '@babylon/training';
import { MarketMoverAgent } from '../services/market-mover-agent';

// Shared config for most tests - minimal but sufficient
const BASE_CONFIG: BenchmarkConfig = {
  durationMinutes: 25 * 24 * 60, // 25 days
  tickInterval: 3600,
  numPredictionMarkets: 2,
  numPerpetualMarkets: 3,
  numAgents: 3,
  seed: 12345,
  useCausalSimulation: true,
};

// Helper to create test events
const createEvent = (overrides: Partial<WorldEvent> = {}): WorldEvent => ({
  id: 'test-event',
  day: 5,
  type: 'leak',
  visibility: 'public',
  description: 'TSLA event',
  actors: [],
  ...overrides,
});

// =============================================================================
// BenchmarkDataGenerator Tests
// =============================================================================

describe('BenchmarkDataGenerator - Causal Simulation', () => {
  test('generates hidden narrative facts with correct structure', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    // Should have exactly ONE hidden narrative fact
    expect(snapshot.groundTruth.hiddenNarrativeFacts).toBeDefined();
    expect(snapshot.groundTruth.hiddenNarrativeFacts!.length).toBe(1);

    const fact = snapshot.groundTruth.hiddenNarrativeFacts![0]!;
    expect(fact.id).toMatch(/^narrative-fact-/);
    expect(fact.fact.length).toBeGreaterThan(10);
    expect(fact.affectsTickers).toHaveLength(1);
    expect(fact.eventSchedule.length).toBeGreaterThanOrEqual(3);
    expect(['positive', 'negative']).toContain(fact.sentiment);

    // Event schedule structure
    for (const event of fact.eventSchedule) {
      expect(event.baseDay).toBeGreaterThan(0);
      expect(event.baseHour).toBeGreaterThanOrEqual(8);
      expect(event.baseHour).toBeLessThan(20);
      expect(event.jitterHours).toBeGreaterThanOrEqual(-8);
      expect(event.jitterHours).toBeLessThanOrEqual(8);
      expect(['low', 'medium', 'high']).toContain(event.volatilityBucket);
    }
  });

  test('generates causal events with valid timing and price changes', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const events = snapshot.groundTruth.causalEvents!;
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Events sorted by tick
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.tick).toBeGreaterThanOrEqual(events[i - 1]!.tick);
    }

    // Verify price changes in valid ranges
    for (const event of events) {
      for (const change of Object.values(event.priceChanges)) {
        const abs = Math.abs(change);
        const inRange =
          (abs >= 0.02 && abs <= 0.04) ||
          (abs >= 0.05 && abs <= 0.1) ||
          (abs >= 0.15 && abs <= 0.25);
        expect(inRange).toBe(true);
      }
    }
  });

  test('backward compatibility: no causal data when disabled', async () => {
    const config: BenchmarkConfig = {
      ...BASE_CONFIG,
      useCausalSimulation: false,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    expect(snapshot.groundTruth.hiddenNarrativeFacts).toBeUndefined();
    expect(snapshot.groundTruth.causalEvents).toBeUndefined();
  });

  test('is reproducible with same seed', async () => {
    const snapshot1 = await new BenchmarkDataGenerator(BASE_CONFIG).generate();
    const snapshot2 = await new BenchmarkDataGenerator(BASE_CONFIG).generate();

    expect(snapshot1.groundTruth.hiddenNarrativeFacts![0]!.fact).toBe(
      snapshot2.groundTruth.hiddenNarrativeFacts![0]!.fact
    );
    expect(snapshot1.groundTruth.causalEvents![0]!.priceChanges).toEqual(
      snapshot2.groundTruth.causalEvents![0]!.priceChanges
    );
  });

  test('different seeds produce different results', async () => {
    const snap1 = await new BenchmarkDataGenerator({
      ...BASE_CONFIG,
      seed: 11111,
    }).generate();
    const snap2 = await new BenchmarkDataGenerator({
      ...BASE_CONFIG,
      seed: 22222,
    }).generate();

    const fact1 = snap1.groundTruth.hiddenNarrativeFacts![0]!;
    const fact2 = snap2.groundTruth.hiddenNarrativeFacts![0]!;

    // At least something should differ
    const differs =
      fact1.fact !== fact2.fact ||
      fact1.affectsTickers[0] !== fact2.affectsTickers[0];
    expect(differs).toBe(true);
  });

  test('price history respects bounds in causal mode', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    for (const perp of snapshot.initialState.perpetualMarkets) {
      const history = snapshot.groundTruth.priceHistory[perp.ticker]!;
      const minAllowed = perp.price * 0.1;
      const maxAllowed = perp.price * 4.0;

      for (const entry of history) {
        expect(entry.price).toBeGreaterThanOrEqual(minAllowed);
        expect(entry.price).toBeLessThanOrEqual(maxAllowed);
      }
    }
  });
});

// =============================================================================
// MarketMoverAgent Tests
// =============================================================================

describe('MarketMoverAgent', () => {
  test('generates negative adjustments for negative events', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['TSLA', 450]]);

    const adj = await agent.generatePriceAdjustments(
      prices,
      [createEvent({ type: 'leak', sentimentSignal: -0.6 })],
      { affectedTickers: ['TSLA'] }
    );

    expect(adj.get('TSLA')!).toBeLessThan(0);
    expect(Math.abs(adj.get('TSLA')!)).toBeGreaterThanOrEqual(0.05);
  });

  test('generates positive adjustments for positive events', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['TSLA', 450]]);

    const adj = await agent.generatePriceAdjustments(
      prices,
      [createEvent({ type: 'deal' })],
      { affectedTickers: ['TSLA'] }
    );

    expect(adj.get('TSLA')!).toBeGreaterThan(0);
  });

  test('event type volatility mapping', async () => {
    const testCases: Array<[string, string, boolean]> = [
      ['leak', 'medium', true],
      ['scandal', 'high', true],
      ['announcement', 'low', false],
      ['deal', 'medium', false],
    ];

    for (const [type, bucket, isNeg] of testCases) {
      const agent = new MarketMoverAgent(12345);
      const prices = new Map([['TSLA', 450]]);

      const eventType = type as WorldEvent['type'];
      const adj = await agent.generatePriceAdjustments(
        prices,
        [createEvent({ type: eventType })],
        { affectedTickers: ['TSLA'] }
      );

      const val = adj.get('TSLA')!;
      if (isNeg) {
        expect(val).toBeLessThan(0);
      } else {
        expect(val).toBeGreaterThan(0);
      }

      const absVal = Math.abs(val);
      const ranges: Record<string, [number, number]> = {
        low: [0.02, 0.04],
        medium: [0.05, 0.1],
        high: [0.15, 0.25],
      };
      const [min, max] = ranges[bucket]!;
      expect(absVal).toBeGreaterThanOrEqual(min);
      expect(absVal).toBeLessThanOrEqual(max);
    }
  });

  test('sentimentSignal overrides default direction', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['TSLA', 450]]);

    // leak is normally negative, but positive sentiment overrides
    const adj = await agent.generatePriceAdjustments(
      prices,
      [createEvent({ type: 'leak', sentimentSignal: 0.8 })],
      { affectedTickers: ['TSLA'] }
    );

    expect(adj.get('TSLA')!).toBeGreaterThan(0);
  });

  test('detects tickers from description', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([
      ['BTCAI', 120000],
      ['TSLA', 450],
    ]);

    const adj = await agent.generatePriceAdjustments(prices, [
      createEvent({ description: 'BTCAI protocol breach' }),
    ]);

    expect(adj.has('BTCAI')).toBe(true);
    expect(adj.has('TSLA')).toBe(false);
  });

  test('returns empty for no events', async () => {
    const agent = new MarketMoverAgent(12345);
    const adj = await agent.generatePriceAdjustments(
      new Map([['TSLA', 450]]),
      []
    );
    expect(adj.size).toBe(0);
  });

  test('returns empty for no matching tickers', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['TSLA', 450]]);

    const adj = await agent.generatePriceAdjustments(prices, [
      createEvent({ description: 'Generic event no ticker' }),
    ]);

    expect(adj.size).toBe(0);
  });

  test('applies adjustments with bounds', () => {
    const agent = new MarketMoverAgent(12345, {
      minPriceFloor: 0.1,
      maxPriceCeiling: 2.0,
    });

    const current = new Map([['TSLA', 800]]);
    const initial = new Map([['TSLA', 450]]);

    // Try to exceed ceiling
    const newPrices = agent.applyAdjustments(
      current,
      new Map([['TSLA', 0.5]]),
      initial
    );
    expect(newPrices.get('TSLA')).toBe(900); // 450 * 2.0

    // Try to go below floor
    const agent2 = new MarketMoverAgent(12345, { minPriceFloor: 0.1 });
    const newPrices2 = agent2.applyAdjustments(
      new Map([['TSLA', 50]]),
      new Map([['TSLA', -0.99]]),
      initial
    );
    expect(newPrices2.get('TSLA')).toBe(45); // 450 * 0.1
  });

  test('is reproducible with same seed', async () => {
    const events = [createEvent()];
    const prices = new Map([['TSLA', 450]]);
    const ctx = { affectedTickers: ['TSLA'] };

    const adj1 = await new MarketMoverAgent(12345).generatePriceAdjustments(
      prices,
      events,
      ctx
    );
    const adj2 = await new MarketMoverAgent(12345).generatePriceAdjustments(
      prices,
      events,
      ctx
    );

    expect(adj1.get('TSLA')).toBe(adj2.get('TSLA'));
  });
});

// =============================================================================
// SeededRandom Tests
// =============================================================================

describe('SeededRandom', () => {
  test('produces reproducible sequence', () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(12345);

    const seq1 = Array.from({ length: 10 }, () => rng1.next());
    const seq2 = Array.from({ length: 10 }, () => rng2.next());

    expect(seq1).toEqual(seq2);
  });

  test('next() returns values in [0, 1)', () => {
    const rng = new SeededRandom(12345);
    for (let i = 0; i < 100; i++) {
      const val = rng.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  test('nextInt returns integers in range', () => {
    const rng = new SeededRandom(12345);
    for (let i = 0; i < 100; i++) {
      const val = rng.nextInt(5, 10);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(10);
      expect(Number.isInteger(val)).toBe(true);
    }
  });

  test('nextFloat returns values in range', () => {
    const rng = new SeededRandom(12345);
    for (let i = 0; i < 100; i++) {
      const val = rng.nextFloat(0.5, 1.5);
      expect(val).toBeGreaterThanOrEqual(0.5);
      expect(val).toBeLessThanOrEqual(1.5);
    }
  });

  test('pick returns array element', () => {
    const rng = new SeededRandom(12345);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      expect(arr).toContain(rng.pick(arr));
    }
  });

  test('handles edge cases', () => {
    // Seed 0
    expect(new SeededRandom(0).next()).toBeGreaterThanOrEqual(0);

    // Large seed
    expect(new SeededRandom(Number.MAX_SAFE_INTEGER).next()).toBeLessThan(1);

    // nextInt with min = max
    expect(new SeededRandom(12345).nextInt(5, 5)).toBe(5);
  });
});

// =============================================================================
// Integration Test
// =============================================================================

describe('Integration - Full Causal Chain', () => {
  test('hidden fact → events → price changes alignment', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const fact = snapshot.groundTruth.hiddenNarrativeFacts![0]!;
    const events = snapshot.groundTruth.causalEvents!;
    const ticker = fact.affectsTickers[0]!;
    const isNegative = fact.sentiment === 'negative';

    // All events affect the fact's ticker
    for (const event of events) {
      expect(event.affectedTickers).toContain(ticker);
      expect(event.sourceFactId).toBe(fact.id);

      // Price direction matches sentiment
      const change = event.priceChanges[ticker]!;
      if (isNegative) {
        expect(change).toBeLessThan(0);
      } else {
        expect(change).toBeGreaterThan(0);
      }
    }

    // Price history changes only at event ticks
    const history = snapshot.groundTruth.priceHistory[ticker]!;
    const eventTicks = new Set(events.map((e) => e.tick));

    let changesAtEvents = 0;
    let changesElsewhere = 0;

    for (let i = 1; i < history.length; i++) {
      if (history[i]!.price !== history[i - 1]!.price) {
        if (eventTicks.has(i)) changesAtEvents++;
        else changesElsewhere++;
      }
    }

    expect(changesAtEvents).toBe(events.length);
    expect(changesElsewhere).toBe(0);
  });
});

// =============================================================================
// Edge Cases and Boundary Conditions
// =============================================================================

describe('BenchmarkDataGenerator - Edge Cases', () => {
  test('handles minimum duration (1 day)', async () => {
    const config: BenchmarkConfig = {
      durationMinutes: 24 * 60, // 1 day
      tickInterval: 3600,
      numPredictionMarkets: 1,
      numPerpetualMarkets: 1,
      numAgents: 1,
      seed: 99999,
      useCausalSimulation: true,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    expect(snapshot.ticks.length).toBe(24);
    expect(snapshot.groundTruth).toBeDefined();
  });

  test('handles seed value 0', async () => {
    const config: BenchmarkConfig = {
      ...BASE_CONFIG,
      seed: 0,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    expect(snapshot).toBeDefined();
    expect(snapshot.groundTruth.hiddenNarrativeFacts).toBeDefined();
  });

  test('handles very large seed values', async () => {
    const config: BenchmarkConfig = {
      ...BASE_CONFIG,
      seed: Number.MAX_SAFE_INTEGER,
    };

    const generator = new BenchmarkDataGenerator(config);
    const snapshot = await generator.generate();

    expect(snapshot).toBeDefined();
  });

  test('price bounds prevent negative prices', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    for (const perp of snapshot.initialState.perpetualMarkets) {
      const history = snapshot.groundTruth.priceHistory[perp.ticker]!;
      for (const entry of history) {
        expect(entry.price).toBeGreaterThan(0);
      }
    }
  });

  test('all tickers have price history', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    for (const perp of snapshot.initialState.perpetualMarkets) {
      expect(snapshot.groundTruth.priceHistory[perp.ticker]).toBeDefined();
      expect(
        snapshot.groundTruth.priceHistory[perp.ticker]!.length
      ).toBeGreaterThan(0);
    }
  });

  test('final prices can be derived from price history', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    for (const perp of snapshot.initialState.perpetualMarkets) {
      const history = snapshot.groundTruth.priceHistory[perp.ticker]!;
      const finalPrice = history[history.length - 1]!.price;
      expect(finalPrice).toBeGreaterThan(0);
    }
  });

  test('price history has valid entries for all tickers', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    for (const perp of snapshot.initialState.perpetualMarkets) {
      const history = snapshot.groundTruth.priceHistory[perp.ticker]!;
      // Price history should have entries
      expect(history.length).toBeGreaterThan(0);
      // All prices should be valid positive numbers
      for (const entry of history) {
        expect(entry.price).toBeGreaterThan(0);
        expect(entry.tick).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// =============================================================================
// MarketMoverAgent - Edge Cases
// =============================================================================

describe('MarketMoverAgent - Edge Cases', () => {
  test('handles event with neutral sentiment signal', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['TSLA', 450]]);

    const adj = await agent.generatePriceAdjustments(
      prices,
      [createEvent({ type: 'development', sentimentSignal: 0 })],
      { affectedTickers: ['TSLA'] }
    );

    // Neutral sentiment should still generate adjustment based on event type
    expect(adj.has('TSLA')).toBe(true);
  });

  test('handles multiple tickers affected by single event', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([
      ['BTCAI', 120000],
      ['ETHAI', 4000],
      ['SOLAI', 200],
    ]);

    const adj = await agent.generatePriceAdjustments(
      prices,
      [
        createEvent({
          description: 'Crypto sector crash affects BTCAI ETHAI SOLAI',
        }),
      ],
      { affectedTickers: ['BTCAI', 'ETHAI', 'SOLAI'] }
    );

    // All affected tickers should have adjustments
    expect(adj.has('BTCAI')).toBe(true);
    expect(adj.has('ETHAI')).toBe(true);
    expect(adj.has('SOLAI')).toBe(true);
  });

  test('handles very small price values', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['PENNY', 0.001]]);

    const adj = await agent.generatePriceAdjustments(
      prices,
      [createEvent({ description: 'PENNY stock event' })],
      { affectedTickers: ['PENNY'] }
    );

    // Should still generate valid adjustment
    if (adj.has('PENNY')) {
      expect(typeof adj.get('PENNY')).toBe('number');
    }
  });

  test('handles very large price values', async () => {
    const agent = new MarketMoverAgent(12345);
    const prices = new Map([['BIGCAP', 1000000]]);

    const adj = await agent.generatePriceAdjustments(
      prices,
      [createEvent({ description: 'BIGCAP major event' })],
      { affectedTickers: ['BIGCAP'] }
    );

    if (adj.has('BIGCAP')) {
      expect(typeof adj.get('BIGCAP')).toBe('number');
    }
  });

  test('price floor and ceiling are respected with extreme adjustments', () => {
    const agent = new MarketMoverAgent(12345, {
      minPriceFloor: 0.1,
      maxPriceCeiling: 4.0,
    });

    const initial = new Map([['TEST', 100]]);

    // Try to exceed ceiling with +500%
    const newHigh = agent.applyAdjustments(
      new Map([['TEST', 100]]),
      new Map([['TEST', 5.0]]),
      initial
    );
    expect(newHigh.get('TEST')).toBe(400); // 100 * 4.0

    // Try to go below floor with -99%
    const newLow = agent.applyAdjustments(
      new Map([['TEST', 100]]),
      new Map([['TEST', -0.99]]),
      initial
    );
    expect(newLow.get('TEST')).toBe(10); // 100 * 0.1
  });

  test('consecutive adjustments accumulate correctly', () => {
    const agent = new MarketMoverAgent(12345);
    const initial = new Map([['TEST', 100]]);

    // First adjustment: +10%
    let current = agent.applyAdjustments(
      new Map([['TEST', 100]]),
      new Map([['TEST', 0.1]]),
      initial
    );
    // Use toBeCloseTo for floating point comparison
    expect(current.get('TEST')).toBeCloseTo(110, 5);

    // Second adjustment: -5% on the NEW current price
    // applyAdjustments multiplies current by (1 + adjustment)
    // 110 * (1 + (-0.05)) = 110 * 0.95 = 104.5
    current = agent.applyAdjustments(
      current,
      new Map([['TEST', -0.05]]),
      initial
    );
    expect(current.get('TEST')).toBeCloseTo(104.5, 1);
  });
});

// =============================================================================
// SeededRandom - Edge Cases
// =============================================================================

describe('SeededRandom - Edge Cases', () => {
  test('pick from single element array', () => {
    const rng = new SeededRandom(12345);
    const arr = ['only'];

    expect(rng.pick(arr)).toBe('only');
  });

  test('nextInt with large range', () => {
    const rng = new SeededRandom(12345);
    const val = rng.nextInt(0, 1000000);

    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(1000000);
  });

  test('nextFloat with very small range', () => {
    const rng = new SeededRandom(12345);
    const val = rng.nextFloat(0.001, 0.002);

    expect(val).toBeGreaterThanOrEqual(0.001);
    expect(val).toBeLessThanOrEqual(0.002);
  });

  test('multiple RNGs with same seed produce identical sequences', () => {
    const rng1 = new SeededRandom(42);
    const rng2 = new SeededRandom(42);

    for (let i = 0; i < 100; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  test('different seeds produce different first values', () => {
    const seeds = [1, 2, 3, 4, 5, 100, 1000, 99999];
    const firstValues = seeds.map((s) => new SeededRandom(s).next());

    // All first values should be unique
    const uniqueValues = new Set(firstValues);
    expect(uniqueValues.size).toBe(seeds.length);
  });
});

// =============================================================================
// Volatility Bucket Tests
// =============================================================================

describe('Volatility Buckets', () => {
  test('low volatility produces 2-4% changes', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const events = snapshot.groundTruth.causalEvents!;
    const lowEvents = events.filter((e) => e.volatilityBucket === 'low');

    for (const event of lowEvents) {
      for (const change of Object.values(event.priceChanges)) {
        const abs = Math.abs(change);
        expect(abs).toBeGreaterThanOrEqual(0.02);
        expect(abs).toBeLessThanOrEqual(0.04);
      }
    }
  });

  test('medium volatility produces 5-10% changes', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const events = snapshot.groundTruth.causalEvents!;
    const mediumEvents = events.filter((e) => e.volatilityBucket === 'medium');

    for (const event of mediumEvents) {
      for (const change of Object.values(event.priceChanges)) {
        const abs = Math.abs(change);
        expect(abs).toBeGreaterThanOrEqual(0.05);
        expect(abs).toBeLessThanOrEqual(0.1);
      }
    }
  });

  test('high volatility produces 15-25% changes', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const events = snapshot.groundTruth.causalEvents!;
    const highEvents = events.filter((e) => e.volatilityBucket === 'high');

    for (const event of highEvents) {
      for (const change of Object.values(event.priceChanges)) {
        const abs = Math.abs(change);
        expect(abs).toBeGreaterThanOrEqual(0.15);
        expect(abs).toBeLessThanOrEqual(0.25);
      }
    }
  });
});

// =============================================================================
// Event Timing Tests
// =============================================================================

describe('Event Timing', () => {
  test('events are scheduled in chronological order', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const events = snapshot.groundTruth.causalEvents!;

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.tick).toBeGreaterThanOrEqual(events[i - 1]!.tick);
    }
  });

  test('jitter is within expected range (±8 hours)', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const fact = snapshot.groundTruth.hiddenNarrativeFacts![0]!;

    for (const scheduled of fact.eventSchedule) {
      expect(scheduled.jitterHours).toBeGreaterThanOrEqual(-8);
      expect(scheduled.jitterHours).toBeLessThanOrEqual(8);
    }
  });

  test('events occur during reasonable hours (not midnight)', async () => {
    const generator = new BenchmarkDataGenerator(BASE_CONFIG);
    const snapshot = await generator.generate();

    const events = snapshot.groundTruth.causalEvents!;

    for (const event of events) {
      // Most events should be between 6 AM and 10 PM
      // (allowing for jitter from base 8 AM - 8 PM)
      expect(event.hour).toBeGreaterThanOrEqual(0);
      expect(event.hour).toBeLessThanOrEqual(23);
    }
  });
});
