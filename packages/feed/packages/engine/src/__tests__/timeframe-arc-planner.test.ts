/**
 * Timeframe Arc Planner Tests
 *
 * Tests for the TimeframeArcPlanner service which creates compressed
 * narrative arc plans for prediction markets with different timeframes.
 */

import { describe, expect, test } from 'bun:test';
import {
  type TimeframeArcPlan,
  TimeframeArcPlanner,
  timeframeArcPlanner,
} from '../services/timeframe-arc-planner';

describe('TimeframeArcPlanner', () => {
  describe('getCategory', () => {
    test('should categorize 15m and 30m as flash', () => {
      expect(TimeframeArcPlanner.getCategory('15m')).toBe('flash');
      expect(TimeframeArcPlanner.getCategory('30m')).toBe('flash');
    });

    test('should categorize 1h and 6h as intraday', () => {
      expect(TimeframeArcPlanner.getCategory('1h')).toBe('intraday');
      expect(TimeframeArcPlanner.getCategory('6h')).toBe('intraday');
    });

    test('should categorize 12h and 1d as daily', () => {
      expect(TimeframeArcPlanner.getCategory('12h')).toBe('daily');
      expect(TimeframeArcPlanner.getCategory('1d')).toBe('daily');
    });

    test('should categorize 2d and 3d as weekly', () => {
      expect(TimeframeArcPlanner.getCategory('2d')).toBe('weekly');
      expect(TimeframeArcPlanner.getCategory('3d')).toBe('weekly');
    });

    test('should default unknown timeframes to weekly', () => {
      expect(TimeframeArcPlanner.getCategory('5d')).toBe('weekly');
      expect(TimeframeArcPlanner.getCategory('unknown')).toBe('weekly');
    });
  });

  describe('planTimeframeArc', () => {
    const mockActors = [
      {
        id: 'actor-1',
        name: 'Test Actor',
        description: 'A test actor',
        tier: 'S_TIER' as const,
        role: 'main' as const,
        personality: 'contrarian',
        domain: ['tech'],
        affiliations: ['org-1'],
      },
      {
        id: 'actor-2',
        name: 'Normal Actor',
        description: 'A normal actor',
        tier: 'A_TIER' as const,
        role: 'supporting' as const,
        personality: 'optimistic',
        domain: ['finance'],
        affiliations: [],
      },
    ];

    const mockOrganizations = [
      {
        id: 'org-1',
        name: 'TechCorp',
        description: 'A tech company',
        type: 'company' as const,
        canBeInvolved: true,
      },
    ];

    test('should create flash arc plan with single live phase', () => {
      const plan = timeframeArcPlanner.planTimeframeArc(
        'q-1',
        'Will AIlon Musk tweet today?',
        '15m',
        15 * 60 * 1000, // 15 minutes
        true,
        mockActors,
        mockOrganizations
      );

      expect(plan.category).toBe('flash');
      expect(plan.phaseOrder).toEqual(['live']);
      expect(plan.phases['live']).toBeDefined();
      expect(plan.phases['live']?.timeRatio).toBe(1.0);
    });

    test('should create intraday arc plan with 2 phases', () => {
      const plan = timeframeArcPlanner.planTimeframeArc(
        'q-2',
        'Will stock price increase?',
        '1h',
        60 * 60 * 1000, // 1 hour
        false,
        mockActors,
        mockOrganizations
      );

      expect(plan.category).toBe('intraday');
      expect(plan.phaseOrder).toEqual(['active', 'climax']);
      expect(plan.phases['active']).toBeDefined();
      expect(plan.phases['climax']).toBeDefined();
    });

    test('should create daily arc plan with 3 phases', () => {
      const plan = timeframeArcPlanner.planTimeframeArc(
        'q-3',
        'Will product launch succeed?',
        '1d',
        24 * 60 * 60 * 1000, // 1 day
        true,
        mockActors,
        mockOrganizations
      );

      expect(plan.category).toBe('daily');
      expect(plan.phaseOrder).toEqual(['setup', 'peak', 'resolution']);
    });

    test('should create weekly arc plan with 4 phases', () => {
      const plan = timeframeArcPlanner.planTimeframeArc(
        'q-4',
        'Will merger be announced?',
        '3d',
        3 * 24 * 60 * 60 * 1000, // 3 days
        true,
        mockActors,
        mockOrganizations
      );

      expect(plan.category).toBe('weekly');
      expect(plan.phaseOrder).toEqual(['early', 'middle', 'late', 'climax']);
    });

    test('should select no deceivers for flash timeframes', () => {
      const flashPlan = timeframeArcPlanner.planTimeframeArc(
        'q-flash',
        'Quick question?',
        '15m',
        15 * 60 * 1000,
        true,
        mockActors,
        mockOrganizations
      );

      // Flash markets should have no deceivers (max=0)
      expect(flashPlan.deceivers.length).toBe(0);
    });

    test('should select up to 1 deceiver for intraday timeframes', () => {
      const intradayPlan = timeframeArcPlanner.planTimeframeArc(
        'q-intraday',
        'Intraday question?',
        '1h',
        60 * 60 * 1000,
        true,
        mockActors,
        mockOrganizations
      );

      // Intraday markets: max=1 deceiver, limited by available contrarian actors
      expect(intradayPlan.deceivers.length).toBeGreaterThanOrEqual(0);
      expect(intradayPlan.deceivers.length).toBeLessThanOrEqual(1);
    });

    test('should select up to 2 deceivers for daily timeframes', () => {
      const dailyPlan = timeframeArcPlanner.planTimeframeArc(
        'q-daily',
        'Daily question?',
        '1d',
        24 * 60 * 60 * 1000,
        true,
        mockActors,
        mockOrganizations
      );

      // Daily markets: max=2 deceivers, limited by available contrarian actors
      expect(dailyPlan.deceivers.length).toBeGreaterThanOrEqual(0);
      expect(dailyPlan.deceivers.length).toBeLessThanOrEqual(2);
    });

    test('should select up to 2 deceivers for weekly timeframes', () => {
      const weeklyPlan = timeframeArcPlanner.planTimeframeArc(
        'q-weekly',
        'Weekly question?',
        '3d',
        3 * 24 * 60 * 60 * 1000,
        true,
        mockActors,
        mockOrganizations
      );

      // Weekly markets: max=2 deceivers, limited by available contrarian actors
      expect(weeklyPlan.deceivers.length).toBeGreaterThanOrEqual(0);
      expect(weeklyPlan.deceivers.length).toBeLessThanOrEqual(2);
    });

    test('should preserve affiliated actor and org IDs', () => {
      const plan = timeframeArcPlanner.planTimeframeArc(
        'q-5',
        'Test question',
        '1d',
        24 * 60 * 60 * 1000,
        true,
        mockActors,
        mockOrganizations,
        ['actor-1', 'actor-2'],
        ['org-1']
      );

      expect(plan.affiliatedActorIds).toEqual(['actor-1', 'actor-2']);
      expect(plan.affiliatedOrgIds).toEqual(['org-1']);
    });

    test('should include outcome in plan', () => {
      const yesPlan = timeframeArcPlanner.planTimeframeArc(
        'q-yes',
        'Will this happen?',
        '1d',
        24 * 60 * 60 * 1000,
        true,
        mockActors,
        mockOrganizations
      );

      const noPlan = timeframeArcPlanner.planTimeframeArc(
        'q-no',
        'Will this happen?',
        '1d',
        24 * 60 * 60 * 1000,
        false,
        mockActors,
        mockOrganizations
      );

      expect(yesPlan.outcome).toBe(true);
      expect(noPlan.outcome).toBe(false);
    });
  });

  describe('getCurrentPhase', () => {
    test('should return correct phase based on elapsed time', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1d',
        category: 'daily',
        outcome: true,
        durationMs: 24 * 60 * 60 * 1000, // 24 hours
        phases: {
          setup: {
            timeRatio: 0.4,
            correctSignalRatio: 0.45,
            clueStrength: [0.2, 0.5],
          },
          peak: {
            timeRatio: 0.35,
            correctSignalRatio: 0.6,
            clueStrength: [0.4, 0.7],
          },
          resolution: {
            timeRatio: 0.25,
            correctSignalRatio: 0.9,
            clueStrength: [0.8, 1.0],
          },
        },
        phaseOrder: ['setup', 'peak', 'resolution'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      const startTime = new Date('2024-01-01T00:00:00Z');

      // At 0% progress -> setup (0-40%)
      const phase0 = timeframeArcPlanner.getCurrentPhase(
        startTime,
        new Date('2024-01-01T00:00:00Z'),
        plan
      );
      expect(phase0).toBe('setup');

      // At 30% progress -> still setup
      const phase30 = timeframeArcPlanner.getCurrentPhase(
        startTime,
        new Date('2024-01-01T07:12:00Z'), // 7.2 hours = 30%
        plan
      );
      expect(phase30).toBe('setup');

      // At 50% progress -> peak (40-75%)
      const phase50 = timeframeArcPlanner.getCurrentPhase(
        startTime,
        new Date('2024-01-01T12:00:00Z'), // 12 hours = 50%
        plan
      );
      expect(phase50).toBe('peak');

      // At 85% progress -> resolution (75-100%)
      const phase85 = timeframeArcPlanner.getCurrentPhase(
        startTime,
        new Date('2024-01-01T20:24:00Z'), // 20.4 hours = 85%
        plan
      );
      expect(phase85).toBe('resolution');
    });

    test('should return null for time before start', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1h',
        category: 'intraday',
        outcome: true,
        durationMs: 60 * 60 * 1000,
        phases: {
          active: {
            timeRatio: 0.7,
            correctSignalRatio: 0.55,
            clueStrength: [0.3, 0.6],
          },
          climax: {
            timeRatio: 0.3,
            correctSignalRatio: 0.85,
            clueStrength: [0.7, 0.95],
          },
        },
        phaseOrder: ['active', 'climax'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      const startTime = new Date('2024-01-01T12:00:00Z');
      const beforeStart = new Date('2024-01-01T11:00:00Z');

      const phase = timeframeArcPlanner.getCurrentPhase(
        startTime,
        beforeStart,
        plan
      );
      expect(phase).toBe(null);
    });

    test('should return null for time after end', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1h',
        category: 'intraday',
        outcome: true,
        durationMs: 60 * 60 * 1000,
        phases: {
          active: {
            timeRatio: 0.7,
            correctSignalRatio: 0.55,
            clueStrength: [0.3, 0.6],
          },
          climax: {
            timeRatio: 0.3,
            correctSignalRatio: 0.85,
            clueStrength: [0.7, 0.95],
          },
        },
        phaseOrder: ['active', 'climax'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      const startTime = new Date('2024-01-01T12:00:00Z');
      const afterEnd = new Date('2024-01-01T14:00:00Z'); // 2 hours after start, but market is only 1 hour

      const phase = timeframeArcPlanner.getCurrentPhase(
        startTime,
        afterEnd,
        plan
      );
      expect(phase).toBe(null);
    });
  });

  describe('getSignalDirection', () => {
    test('should return valid signal direction', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1d',
        category: 'daily',
        outcome: true,
        durationMs: 24 * 60 * 60 * 1000,
        phases: {
          resolution: {
            timeRatio: 0.25,
            correctSignalRatio: 1.0,
            clueStrength: [0.8, 1.0],
          },
        },
        phaseOrder: ['resolution'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      // With 100% correct signal ratio, should always return 'correct'
      const direction = timeframeArcPlanner.getSignalDirection(
        'resolution',
        plan
      );
      expect(direction).toBe('correct');
    });

    test('should return ambiguous for unknown phase', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1d',
        category: 'daily',
        outcome: true,
        durationMs: 24 * 60 * 60 * 1000,
        phases: {},
        phaseOrder: [],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      const direction = timeframeArcPlanner.getSignalDirection('unknown', plan);
      expect(direction).toBe('ambiguous');
    });
  });

  describe('getClueStrength', () => {
    test('should return value within configured range', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1d',
        category: 'daily',
        outcome: true,
        durationMs: 24 * 60 * 60 * 1000,
        phases: {
          resolution: {
            timeRatio: 0.25,
            correctSignalRatio: 0.9,
            clueStrength: [0.8, 1.0],
          },
        },
        phaseOrder: ['resolution'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      // Run multiple times to verify range (100 iterations reduces flakiness)
      for (let i = 0; i < 100; i++) {
        const strength = timeframeArcPlanner.getClueStrength(
          'resolution',
          plan
        );
        expect(strength).toBeGreaterThanOrEqual(0.8);
        expect(strength).toBeLessThanOrEqual(1.0);
      }
    });

    test('should return 0.5 for unknown phase', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '1d',
        category: 'daily',
        outcome: true,
        durationMs: 24 * 60 * 60 * 1000,
        phases: {},
        phaseOrder: [],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      const strength = timeframeArcPlanner.getClueStrength('unknown', plan);
      expect(strength).toBe(0.5);
    });
  });

  describe('calculateExpectedCertainty', () => {
    test('should return increasing certainty over time', () => {
      const plan: TimeframeArcPlan = {
        questionId: 'q-1',
        timeframe: '3d',
        category: 'weekly',
        outcome: true,
        durationMs: 3 * 24 * 60 * 60 * 1000,
        phases: {
          early: {
            timeRatio: 0.3,
            correctSignalRatio: 0.43,
            clueStrength: [0.2, 0.5],
          },
          middle: {
            timeRatio: 0.3,
            correctSignalRatio: 0.55,
            clueStrength: [0.4, 0.7],
          },
          late: {
            timeRatio: 0.25,
            correctSignalRatio: 0.78,
            clueStrength: [0.6, 0.9],
          },
          climax: {
            timeRatio: 0.15,
            correctSignalRatio: 1.0,
            clueStrength: [0.85, 1.0],
          },
        },
        phaseOrder: ['early', 'middle', 'late', 'climax'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      };

      const certainty0 = timeframeArcPlanner.calculateExpectedCertainty(
        0.1,
        plan
      );
      const certainty50 = timeframeArcPlanner.calculateExpectedCertainty(
        0.5,
        plan
      );
      const certainty90 = timeframeArcPlanner.calculateExpectedCertainty(
        0.9,
        plan
      );

      // Certainty should generally increase over time
      expect(certainty0).toBe(0.43); // early phase
      expect(certainty50).toBe(0.55); // middle phase
      expect(certainty90).toBe(1.0); // climax phase
    });
  });
});

describe('Phase Configuration Validation', () => {
  test('flash phases should sum to 1.0 time ratio', () => {
    const plan = timeframeArcPlanner.planTimeframeArc(
      'q-1',
      'Test',
      '15m',
      15 * 60 * 1000,
      true,
      [],
      []
    );

    const totalRatio = Object.values(plan.phases).reduce(
      (sum, phase) => sum + phase.timeRatio,
      0
    );
    expect(totalRatio).toBeCloseTo(1.0);
  });

  test('intraday phases should sum to 1.0 time ratio', () => {
    const plan = timeframeArcPlanner.planTimeframeArc(
      'q-1',
      'Test',
      '1h',
      60 * 60 * 1000,
      true,
      [],
      []
    );

    const totalRatio = Object.values(plan.phases).reduce(
      (sum, phase) => sum + phase.timeRatio,
      0
    );
    expect(totalRatio).toBeCloseTo(1.0);
  });

  test('daily phases should sum to 1.0 time ratio', () => {
    const plan = timeframeArcPlanner.planTimeframeArc(
      'q-1',
      'Test',
      '1d',
      24 * 60 * 60 * 1000,
      true,
      [],
      []
    );

    const totalRatio = Object.values(plan.phases).reduce(
      (sum, phase) => sum + phase.timeRatio,
      0
    );
    expect(totalRatio).toBeCloseTo(1.0);
  });

  test('weekly phases should sum to 1.0 time ratio', () => {
    const plan = timeframeArcPlanner.planTimeframeArc(
      'q-1',
      'Test',
      '3d',
      3 * 24 * 60 * 60 * 1000,
      true,
      [],
      []
    );

    const totalRatio = Object.values(plan.phases).reduce(
      (sum, phase) => sum + phase.timeRatio,
      0
    );
    expect(totalRatio).toBeCloseTo(1.0);
  });
});
