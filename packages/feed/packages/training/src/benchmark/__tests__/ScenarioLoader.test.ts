/**
 * ScenarioLoader Tests
 *
 * Tests scenario loading, validation, and caching functionality.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import {
  isValidScenarioId,
  type ScenarioId,
  ScenarioLoader,
  ScenarioValidationError,
} from '../ScenarioLoader';

// =============================================================================
// isValidScenarioId Tests
// =============================================================================

describe('isValidScenarioId', () => {
  test('returns true for valid scenario IDs', () => {
    expect(isValidScenarioId('bull-market')).toBe(true);
    expect(isValidScenarioId('bear-market')).toBe(true);
    expect(isValidScenarioId('scandal-unfolds')).toBe(true);
    expect(isValidScenarioId('pump-and-dump')).toBe(true);
  });

  test('returns false for invalid scenario IDs', () => {
    expect(isValidScenarioId('invalid')).toBe(false);
    expect(isValidScenarioId('bull_market')).toBe(false);
    expect(isValidScenarioId('BULL-MARKET')).toBe(false);
    expect(isValidScenarioId('')).toBe(false);
    expect(isValidScenarioId('bull-market-2')).toBe(false);
  });

  test('type guard narrows type correctly', () => {
    const id = 'bull-market';
    if (isValidScenarioId(id)) {
      // This should compile - id is now ScenarioId
      const scenarioId: ScenarioId = id;
      expect(scenarioId).toBe('bull-market');
    }
  });
});

// =============================================================================
// ScenarioLoader - Loading Tests
// =============================================================================

describe('ScenarioLoader - Loading', () => {
  test('loads bull-market scenario successfully', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('bull-market');

    expect(scenario.id).toBe('bull-market');
    expect(scenario.name).toBe('Bull Market Rally');
    expect(scenario.marketCondition).toBe('bull');
    expect(scenario.useCausalSimulation).toBe(false);
    expect(scenario.snapshot).toBeDefined();
    expect(scenario.snapshot.ticks.length).toBeGreaterThan(0);
  });

  test('loads bear-market scenario successfully', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('bear-market');

    expect(scenario.id).toBe('bear-market');
    expect(scenario.name).toBe('Bear Market Crash');
    expect(scenario.marketCondition).toBe('bear');
    expect(scenario.useCausalSimulation).toBe(false);
  });

  test('loads scandal-unfolds scenario with causal events', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('scandal-unfolds');

    expect(scenario.id).toBe('scandal-unfolds');
    expect(scenario.useCausalSimulation).toBe(true);
    expect(scenario.snapshot.groundTruth.causalEvents).toBeDefined();
    expect(scenario.snapshot.groundTruth.causalEvents!.length).toBeGreaterThan(
      0
    );
    expect(
      scenario.snapshot.groundTruth.hiddenNarrativeFacts!.length
    ).toBeGreaterThan(0);
  });

  test('loads pump-and-dump scenario with causal events', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('pump-and-dump');

    expect(scenario.id).toBe('pump-and-dump');
    expect(scenario.useCausalSimulation).toBe(true);
    expect(scenario.snapshot.groundTruth.causalEvents).toBeDefined();
  });

  test('caches loaded scenarios', async () => {
    const loader = new ScenarioLoader();

    // Load twice
    const scenario1 = await loader.loadScenario('bull-market');
    const scenario2 = await loader.loadScenario('bull-market');

    // Should be same object reference (cached)
    expect(scenario1).toBe(scenario2);
  });

  test('throws error for non-existent scenario file', async () => {
    // Create loader with non-existent directory
    const loader = new ScenarioLoader('/tmp/non-existent-scenarios');

    await expect(loader.loadScenario('bull-market')).rejects.toThrow();
  });
});

// =============================================================================
// ScenarioLoader - Listing Tests
// =============================================================================

describe('ScenarioLoader - Listing', () => {
  test('lists all available scenarios', async () => {
    const loader = new ScenarioLoader();
    const scenarios = await loader.listScenarios();

    expect(scenarios.length).toBe(4);

    const ids = scenarios.map((s) => s.id);
    expect(ids).toContain('bull-market');
    expect(ids).toContain('bear-market');
    expect(ids).toContain('scandal-unfolds');
    expect(ids).toContain('pump-and-dump');
  });

  test('scenario metadata includes required fields', async () => {
    const loader = new ScenarioLoader();
    const scenarios = await loader.listScenarios();

    for (const scenario of scenarios) {
      expect(scenario.id).toBeDefined();
      expect(scenario.name).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(scenario.marketCondition).toBeDefined();
      expect(scenario.durationDays).toBeGreaterThan(0);
      expect(scenario.tickCount).toBeGreaterThan(0);
      expect(typeof scenario.useCausalSimulation).toBe('boolean');
    }
  });

  test('all scenario IDs are valid', () => {
    const validIds: ScenarioId[] = [
      'bull-market',
      'bear-market',
      'scandal-unfolds',
      'pump-and-dump',
    ];

    for (const id of validIds) {
      expect(isValidScenarioId(id)).toBe(true);
    }
  });
});

// =============================================================================
// ScenarioLoader - Snapshot Tests
// =============================================================================

describe('ScenarioLoader - Snapshot Access', () => {
  test('getSnapshot returns only the snapshot data', async () => {
    const loader = new ScenarioLoader();
    const snapshot = await loader.getSnapshot('bull-market');

    expect(snapshot.id).toBeDefined();
    expect(snapshot.duration).toBeGreaterThan(0);
    expect(snapshot.tickInterval).toBeGreaterThan(0);
    expect(snapshot.ticks).toBeDefined();
    expect(snapshot.initialState).toBeDefined();
    expect(snapshot.groundTruth).toBeDefined();
  });

  test('snapshot initialState has required market data', async () => {
    const loader = new ScenarioLoader();
    const snapshot = await loader.getSnapshot('bear-market');

    expect(snapshot.initialState.predictionMarkets.length).toBeGreaterThan(0);
    expect(snapshot.initialState.perpetualMarkets.length).toBeGreaterThan(0);
    expect(snapshot.initialState.agents.length).toBeGreaterThan(0);
  });

  test('snapshot ticks are sequential', async () => {
    const loader = new ScenarioLoader();
    const snapshot = await loader.getSnapshot('bull-market');

    for (let i = 0; i < snapshot.ticks.length; i++) {
      expect(snapshot.ticks[i]!.number).toBe(i);
    }
  });

  test('snapshot groundTruth has price history', async () => {
    const loader = new ScenarioLoader();
    const snapshot = await loader.getSnapshot('bull-market');

    expect(snapshot.groundTruth.priceHistory).toBeDefined();
    expect(
      Object.keys(snapshot.groundTruth.priceHistory).length
    ).toBeGreaterThan(0);
  });
});

// =============================================================================
// ScenarioLoader - Validation Tests
// =============================================================================

describe('ScenarioLoader - Validation', () => {
  test('validateAllScenarios passes for valid scenarios', async () => {
    const loader = new ScenarioLoader();
    const result = await loader.validateAllScenarios();

    expect(result.valid).toBe(true);
    expect(Object.keys(result.errors).length).toBe(0);
  });

  test('scenario has valid success criteria', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('bear-market');

    expect(scenario.successCriteria).toBeDefined();
    expect(typeof scenario.successCriteria.traderMinPnlRatio).toBe('number');
    expect(typeof scenario.successCriteria.scammerMinAlpha).toBe('number');
    expect(typeof scenario.successCriteria.degenMinTrades).toBe('number');
  });

  test('scenario has expected behavior for all archetypes', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('scandal-unfolds');

    expect(scenario.expectedBehavior.trader).toBeDefined();
    expect(scenario.expectedBehavior.degen).toBeDefined();
    expect(scenario.expectedBehavior.scammer).toBeDefined();
    expect(scenario.expectedBehavior['social-butterfly']).toBeDefined();
  });

  test('causal scenarios have hidden narrative facts', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('scandal-unfolds');

    expect(scenario.useCausalSimulation).toBe(true);
    expect(scenario.snapshot.groundTruth.hiddenNarrativeFacts).toBeDefined();
    expect(
      scenario.snapshot.groundTruth.hiddenNarrativeFacts!.length
    ).toBeGreaterThan(0);

    const fact = scenario.snapshot.groundTruth.hiddenNarrativeFacts![0]!;
    // Facts have 'id' and 'fact' properties
    expect(fact.id).toBeDefined();
    expect(fact.fact).toBeDefined();
  });

  test('non-causal scenarios have no causal events', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('bull-market');

    expect(scenario.useCausalSimulation).toBe(false);
    // Causal events array should be empty or undefined
    const causalEvents = scenario.snapshot.groundTruth.causalEvents;
    expect(!causalEvents || causalEvents.length === 0).toBe(true);
  });
});

// =============================================================================
// ScenarioLoader - Edge Cases
// =============================================================================

describe('ScenarioLoader - Edge Cases', () => {
  test('handles custom scenario directory', async () => {
    // Using the actual scenario directory
    const actualDir = path.resolve(
      import.meta.dir,
      '../../../data/benchmarks/scenarios'
    );
    const loader = new ScenarioLoader(actualDir);
    const scenarios = await loader.listScenarios();

    expect(scenarios.length).toBe(4);
  });

  test('clearCache removes cached scenarios', async () => {
    const loader = new ScenarioLoader();

    // Load to cache
    const scenario1 = await loader.loadScenario('bull-market');

    // Clear cache
    loader.clearCache();

    // Load again - should be different object
    const scenario2 = await loader.loadScenario('bull-market');

    // Data should be equal but not same reference
    expect(scenario1.id).toBe(scenario2.id);
    expect(scenario1).not.toBe(scenario2); // Different object after cache clear
  });

  test('scenario duration matches tick count and interval', async () => {
    const loader = new ScenarioLoader();
    const scenario = await loader.loadScenario('bull-market');

    const expectedTicks = Math.floor(
      scenario.snapshot.duration / scenario.snapshot.tickInterval
    );

    expect(scenario.snapshot.ticks.length).toBe(expectedTicks);
  });
});

// =============================================================================
// ScenarioValidationError Tests
// =============================================================================

describe('ScenarioValidationError', () => {
  test('formats error message correctly', () => {
    const error = new ScenarioValidationError('test-scenario', [
      'Missing field A',
      'Invalid field B',
    ]);

    expect(error.name).toBe('ScenarioValidationError');
    expect(error.scenarioId).toBe('test-scenario');
    expect(error.issues).toEqual(['Missing field A', 'Invalid field B']);
    expect(error.message).toContain('test-scenario');
    expect(error.message).toContain('Missing field A');
    expect(error.message).toContain('Invalid field B');
  });

  test('is instanceof Error', () => {
    const error = new ScenarioValidationError('test', ['issue']);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof ScenarioValidationError).toBe(true);
  });
});
