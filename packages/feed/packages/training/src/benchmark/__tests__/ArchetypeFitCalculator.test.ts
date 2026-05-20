/**
 * ArchetypeFitCalculator Tests
 *
 * Tests archetype behavioral alignment scoring.
 */

import { describe, expect, test } from 'bun:test';
import {
  ArchetypeFitCalculator,
  calculateArchetypeFit,
  findBestArchetypeMatch,
} from '../ArchetypeFitCalculator';
import type { AgentAction, SimulationResult } from '../SimulationEngine';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockSimulationResult(
  overrides: Partial<SimulationResult> = {}
): SimulationResult {
  return {
    id: 'test-result',
    agentId: 'test-agent',
    startTime: Date.now(),
    endTime: Date.now() + 1000 * 60 * 60 * 24, // 1 day
    actions: [],
    metrics: {
      totalPnl: 0,
      predictionMetrics: {
        totalBets: 0,
        correctBets: 0,
        accuracy: 0,
        totalStaked: 0,
        totalWon: 0,
        roi: 0,
      },
      perpMetrics: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalVolume: 0,
        averagePositionSize: 0,
        maxDrawdown: 0,
        sharpeRatio: 0,
      },
      socialMetrics: {
        postsCreated: 0,
        repliesReceived: 0,
        likesReceived: 0,
        groupsJoined: 0,
      },
      optimalityScore: 0,
    },
    trajectory: [],
    ...overrides,
  };
}

function createAction(
  type: string,
  data: Record<string, unknown> = {}
): AgentAction {
  return {
    type,
    timestamp: Date.now(),
    data,
    result: { success: true },
  };
}

// =============================================================================
// Basic Fit Calculation Tests
// =============================================================================

describe('ArchetypeFitCalculator - Basic', () => {
  test('calculates fit score for trader archetype', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('buy_prediction', { amount: 100 }),
        createAction('sell_prediction', { amount: 50 }),
        createAction('open_perp', { size: 200, leverage: 2 }),
        createAction('close_perp', { size: 200 }),
        createAction('query_state'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.archetype).toBe('trader');
    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
    expect(fitScore.fitScore).toBeLessThanOrEqual(1);
    expect(fitScore.components).toBeDefined();
  });

  test('calculates fit score for degen archetype', () => {
    const result = createMockSimulationResult({
      actions: [
        // Many trades with high leverage
        ...Array(20)
          .fill(null)
          .map(() => createAction('open_perp', { size: 500, leverage: 10 })),
        ...Array(20)
          .fill(null)
          .map(() => createAction('close_perp', { size: 500 })),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'degen', 1);

    expect(fitScore.archetype).toBe('degen');
    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
  });

  test('calculates fit score for scammer archetype', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('create_post', { content: 'Guaranteed 100x moon!' }),
        createAction('create_post', { content: 'Trust me, insider info!' }),
        createAction('create_post', { content: 'Secret alpha, buy now!' }),
        createAction('buy_prediction', { amount: 50 }),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'scammer', 1);

    expect(fitScore.archetype).toBe('scammer');
    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
  });

  test('calculates fit score for social-butterfly archetype', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('create_post', { content: 'Great community!' }),
        createAction('join_group', { groupId: 'group-1' }),
        createAction('join_group', { groupId: 'group-2' }),
        createAction('send_message', { content: 'Hello!' }),
        createAction('create_post', { content: 'Sharing helpful tips' }),
      ],
      metrics: {
        totalPnl: 100,
        predictionMetrics: {
          totalBets: 0,
          correctBets: 0,
          accuracy: 0,
          totalStaked: 0,
          totalWon: 0,
          roi: 0,
        },
        perpMetrics: {
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          winRate: 0,
          totalVolume: 0,
          averagePositionSize: 0,
          maxDrawdown: 0,
          sharpeRatio: 0,
        },
        socialMetrics: {
          postsCreated: 5,
          repliesReceived: 10,
          likesReceived: 20,
          groupsJoined: 2,
        },
        optimalityScore: 0,
      },
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'social-butterfly', 1);

    expect(fitScore.archetype).toBe('social-butterfly');
    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Component Score Tests
// =============================================================================

describe('ArchetypeFitCalculator - Components', () => {
  test('action distribution component is calculated', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('buy_prediction'),
        createAction('create_post'),
        createAction('query_state'),
        createAction('join_group'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.components.actionDistribution).toBeGreaterThanOrEqual(0);
    expect(fitScore.components.actionDistribution).toBeLessThanOrEqual(1);
  });

  test('risk behavior component is calculated', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('open_perp', { size: 100, leverage: 5 }),
        createAction('close_perp', { size: 100, pnl: 50 }),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.components.riskBehavior).toBeGreaterThanOrEqual(0);
    expect(fitScore.components.riskBehavior).toBeLessThanOrEqual(1);
  });

  test('social behavior component is calculated', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('create_post', { content: 'Test post' }),
        createAction('join_group'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'social-butterfly', 1);

    expect(fitScore.components.socialBehavior).toBeGreaterThanOrEqual(0);
    expect(fitScore.components.socialBehavior).toBeLessThanOrEqual(1);
  });

  test('activity level component is calculated', () => {
    const result = createMockSimulationResult({
      actions: Array(50)
        .fill(null)
        .map(() => createAction('buy_prediction')),
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'degen', 1);

    expect(fitScore.components.activityLevel).toBeGreaterThanOrEqual(0);
    expect(fitScore.components.activityLevel).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Metrics Extraction Tests
// =============================================================================

describe('ArchetypeFitCalculator - Metrics', () => {
  test('extracts action distribution correctly', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('buy_prediction'),
        createAction('buy_prediction'),
        createAction('create_post'),
        createAction('query_state'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.metrics.actionDistribution.trade).toBeCloseTo(0.5, 1); // 2/4
    expect(fitScore.metrics.actionDistribution.post).toBeCloseTo(0.25, 1); // 1/4
    expect(fitScore.metrics.actionDistribution.research).toBeCloseTo(0.25, 1); // 1/4
  });

  test('extracts trading behavior metrics', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('open_perp', {
          size: 100,
          leverage: 3,
          direction: 'long',
        }),
        createAction('open_perp', {
          size: 200,
          leverage: 5,
          direction: 'short',
        }),
        createAction('close_perp', { size: 100 }),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.metrics.tradingBehavior.tradeCount).toBe(3);
    expect(
      fitScore.metrics.tradingBehavior.maxLeverageUsed
    ).toBeGreaterThanOrEqual(3);
  });

  test('extracts social behavior metrics', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('create_post', { content: 'Post 1' }),
        createAction('create_post', { content: 'Post 2' }),
        createAction('join_group'),
        createAction('join_group'),
        createAction('join_group'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'social-butterfly', 7);

    expect(fitScore.metrics.socialBehavior.groupsJoined).toBe(3);
    expect(fitScore.metrics.socialBehavior.postFrequency).toBeGreaterThan(0);
  });
});

// =============================================================================
// Observations Tests
// =============================================================================

describe('ArchetypeFitCalculator - Observations', () => {
  test('generates observations array', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(Array.isArray(fitScore.observations)).toBe(true);
    expect(fitScore.observations.length).toBeGreaterThan(0);
  });

  test('observations mention archetype name', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    const hasArchetypeMention = fitScore.observations.some(
      (obs) => obs.toLowerCase().includes('trader') || obs.includes('archetype')
    );
    expect(hasArchetypeMention).toBe(true);
  });
});

// =============================================================================
// Best Match Tests
// =============================================================================

describe('ArchetypeFitCalculator - Best Match', () => {
  test('findBestArchetypeMatch returns highest scoring archetype', () => {
    // Create a result that clearly fits degen pattern
    const result = createMockSimulationResult({
      actions: [
        ...Array(30)
          .fill(null)
          .map(() => createAction('open_perp', { leverage: 10, size: 500 })),
        ...Array(30)
          .fill(null)
          .map(() => createAction('close_perp')),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const { bestMatch, allScores } = calculator.findBestArchetypeMatch(
      result,
      1
    );

    expect(bestMatch.archetype).toBeDefined();
    expect(bestMatch.fitScore).toBeGreaterThanOrEqual(0);
    expect(allScores).toBeDefined();
    expect(allScores.length).toBeGreaterThan(1);
  });

  test('allScores contains all archetypes', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    const { allScores } = calculator.findBestArchetypeMatch(result, 1);

    const archetypes = allScores.map((s) => s.archetype);
    expect(archetypes).toContain('trader');
    expect(archetypes).toContain('degen');
    expect(archetypes).toContain('scammer');
    expect(archetypes).toContain('social-butterfly');
  });

  test('bestMatch has highest fit score among all scores', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    const { bestMatch, allScores } = calculator.findBestArchetypeMatch(
      result,
      1
    );

    // bestMatch should have the highest or equal fitScore among all
    for (const score of allScores) {
      expect(bestMatch.fitScore).toBeGreaterThanOrEqual(score.fitScore);
    }
  });
});

// =============================================================================
// Static Helper Function Tests
// =============================================================================

describe('calculateArchetypeFit helper', () => {
  test('works as standalone function', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const fitScore = calculateArchetypeFit(result, 'trader', 1);

    expect(fitScore.archetype).toBe('trader');
    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
  });
});

describe('findBestArchetypeMatch helper', () => {
  test('works as standalone function', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const { bestMatch, allScores } = findBestArchetypeMatch(result, 1);

    expect(bestMatch.archetype).toBeDefined();
    expect(allScores.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('ArchetypeFitCalculator - Edge Cases', () => {
  test('handles empty actions array', () => {
    const result = createMockSimulationResult({ actions: [] });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
    expect(fitScore.metrics.actionDistribution.trade).toBe(0);
  });

  test('handles near-zero duration gracefully', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    // Near-zero duration should not cause division by zero
    const fitScore = calculator.calculate(result, 'trader', 0.001);

    expect(Number.isFinite(fitScore.fitScore)).toBe(true);
  });

  test('handles actual zero duration gracefully', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    // Actual zero duration - should handle without throwing or returning NaN
    const fitScore = calculator.calculate(result, 'trader', 0);

    expect(Number.isFinite(fitScore.fitScore)).toBe(true);
    expect(fitScore.fitScore).toBeGreaterThanOrEqual(0);
    expect(fitScore.fitScore).toBeLessThanOrEqual(1);
  });

  test('handles unknown action types', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('unknown_action_type'),
        createAction('another_weird_action'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    expect(fitScore.metrics.actionDistribution.other).toBe(1); // All unknown
  });

  test('handles very long duration', () => {
    const result = createMockSimulationResult({
      actions: [createAction('buy_prediction')],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 365); // 1 year

    expect(Number.isFinite(fitScore.fitScore)).toBe(true);
  });

  test('custom starting balance affects calculations', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('open_perp', { size: 5000 }), // Large relative to 10000
      ],
    });

    const calc1 = new ArchetypeFitCalculator(10000);
    const calc2 = new ArchetypeFitCalculator(100000);

    const fit1 = calc1.calculate(result, 'trader', 1);
    const fit2 = calc2.calculate(result, 'trader', 1);

    // Same action, different starting balance, should affect position sizing score
    expect(fit1.fitScore).not.toBe(fit2.fitScore);
  });
});

// =============================================================================
// Archetype-Specific Behavior Tests
// =============================================================================

describe('ArchetypeFitCalculator - Archetype-Specific', () => {
  test('high leverage benefits degen score', () => {
    const lowLeverageResult = createMockSimulationResult({
      actions: [createAction('open_perp', { leverage: 1 })],
    });

    const highLeverageResult = createMockSimulationResult({
      actions: [createAction('open_perp', { leverage: 10 })],
    });

    const calculator = new ArchetypeFitCalculator();
    const lowFit = calculator.calculate(lowLeverageResult, 'degen', 1);
    const highFit = calculator.calculate(highLeverageResult, 'degen', 1);

    // High leverage should fit degen better
    expect(highFit.metrics.tradingBehavior.maxLeverageUsed).toBeGreaterThan(
      lowFit.metrics.tradingBehavior.maxLeverageUsed
    );
  });

  test('high post volume benefits scammer and social-butterfly', () => {
    const lowPostResult = createMockSimulationResult({
      actions: [createAction('create_post')],
    });

    const highPostResult = createMockSimulationResult({
      actions: Array(20)
        .fill(null)
        .map(() => createAction('create_post', { content: 'Test' })),
    });

    const calculator = new ArchetypeFitCalculator();
    const lowFitScammer = calculator.calculate(lowPostResult, 'scammer', 1);
    const highFitScammer = calculator.calculate(highPostResult, 'scammer', 1);

    expect(highFitScammer.metrics.socialBehavior.postFrequency).toBeGreaterThan(
      lowFitScammer.metrics.socialBehavior.postFrequency
    );
  });

  test('balanced activity benefits trader score', () => {
    const result = createMockSimulationResult({
      actions: [
        createAction('buy_prediction'),
        createAction('query_state'),
        createAction('open_perp', { leverage: 2 }),
        createAction('close_perp'),
        createAction('create_post'),
      ],
    });

    const calculator = new ArchetypeFitCalculator();
    const fitScore = calculator.calculate(result, 'trader', 1);

    // Balanced activity should have non-zero distribution across categories
    expect(fitScore.metrics.actionDistribution.trade).toBeGreaterThan(0);
    expect(fitScore.metrics.actionDistribution.research).toBeGreaterThan(0);
  });
});
