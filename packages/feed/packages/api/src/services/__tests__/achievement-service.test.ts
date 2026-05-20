import { describe, expect, it } from 'bun:test';
import {
  ACHIEVEMENT_DEFINITIONS,
  ALL_CHALLENGE_DEFINITIONS,
  DAILY_CHALLENGE_DEFINITIONS,
  EVENT_TO_TRACKING_TYPES,
  WEEKLY_CHALLENGE_DEFINITIONS,
} from '@babylon/shared';
import {
  getActiveDailyChallengeIds,
  getActiveWeeklyChallengeIds,
} from '../achievement-service';

describe('Achievement Definitions', () => {
  it('has exactly 15 achievements', () => {
    expect(ACHIEVEMENT_DEFINITIONS).toHaveLength(15);
  });

  it('has unique achievement IDs', () => {
    const ids = ACHIEVEMENT_DEFINITIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all achievements have required fields', () => {
    for (const def of ACHIEVEMENT_DEFINITIONS) {
      expect(def.id).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(['trading', 'agents', 'social', 'exploration']).toContain(
        def.category
      );
      expect(['bronze', 'silver', 'gold']).toContain(def.tier);
      expect(def.pointsReward).toBeGreaterThan(0);
      expect(def.threshold).toBeGreaterThan(0);
      expect(def.trackingType).toBeTruthy();
    }
  });

  it('has 8 bronze, 5 silver, 2 gold', () => {
    const bronze = ACHIEVEMENT_DEFINITIONS.filter((a) => a.tier === 'bronze');
    const silver = ACHIEVEMENT_DEFINITIONS.filter((a) => a.tier === 'silver');
    const gold = ACHIEVEMENT_DEFINITIONS.filter((a) => a.tier === 'gold');
    expect(bronze).toHaveLength(8);
    expect(silver).toHaveLength(5);
    expect(gold).toHaveLength(2);
  });
});

describe('Challenge Definitions', () => {
  it('has 20 daily and 20 weekly challenges', () => {
    expect(DAILY_CHALLENGE_DEFINITIONS).toHaveLength(20);
    expect(WEEKLY_CHALLENGE_DEFINITIONS).toHaveLength(20);
    expect(ALL_CHALLENGE_DEFINITIONS).toHaveLength(40);
  });

  it('has unique challenge IDs', () => {
    const ids = ALL_CHALLENGE_DEFINITIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('daily challenges have pool=daily, weekly have pool=weekly', () => {
    for (const c of DAILY_CHALLENGE_DEFINITIONS) {
      expect(c.pool).toBe('daily');
    }
    for (const c of WEEKLY_CHALLENGE_DEFINITIONS) {
      expect(c.pool).toBe('weekly');
    }
  });

  it('all challenges have required fields', () => {
    for (const def of ALL_CHALLENGE_DEFINITIONS) {
      expect(def.id).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.pointsReward).toBeGreaterThan(0);
      expect(def.threshold).toBeGreaterThan(0);
      expect(def.trackingType).toBeTruthy();
    }
  });
});

describe('Challenge Rotation', () => {
  it('returns exactly 3 daily challenges', () => {
    const ids = getActiveDailyChallengeIds(new Date('2026-03-09'));
    expect(ids).toHaveLength(3);
  });

  it('returns exactly 2 weekly challenges', () => {
    const ids = getActiveWeeklyChallengeIds(new Date('2026-03-09'));
    expect(ids).toHaveLength(2);
  });

  it('daily challenge IDs are valid daily challenge IDs', () => {
    const validIds = new Set(DAILY_CHALLENGE_DEFINITIONS.map((c) => c.id));
    const ids = getActiveDailyChallengeIds(new Date('2026-03-09'));
    for (const id of ids) {
      expect(validIds.has(id)).toBe(true);
    }
  });

  it('weekly challenge IDs are valid weekly challenge IDs', () => {
    const validIds = new Set(WEEKLY_CHALLENGE_DEFINITIONS.map((c) => c.id));
    const ids = getActiveWeeklyChallengeIds(new Date('2026-03-09'));
    for (const id of ids) {
      expect(validIds.has(id)).toBe(true);
    }
  });

  it('daily rotation is deterministic (same day = same challenges)', () => {
    const date = new Date('2026-06-15');
    const ids1 = getActiveDailyChallengeIds(date);
    const ids2 = getActiveDailyChallengeIds(date);
    expect(ids1).toEqual(ids2);
  });

  it('weekly rotation is deterministic (same week = same challenges)', () => {
    const monday = new Date('2026-06-15');
    const wednesday = new Date('2026-06-17');
    const ids1 = getActiveWeeklyChallengeIds(monday);
    const ids2 = getActiveWeeklyChallengeIds(wednesday);
    expect(ids1).toEqual(ids2);
  });

  it('different days produce different daily challenges (most of the time)', () => {
    const ids1 = getActiveDailyChallengeIds(new Date('2026-03-09'));
    const ids2 = getActiveDailyChallengeIds(new Date('2026-03-10'));
    // Very unlikely to be identical with 20-choose-3
    expect(ids1).not.toEqual(ids2);
  });

  it('daily challenge IDs are unique (no duplicates)', () => {
    const ids = getActiveDailyChallengeIds(new Date('2026-03-09'));
    expect(new Set(ids).size).toBe(3);
  });

  it('weekly challenge IDs are unique (no duplicates)', () => {
    const ids = getActiveWeeklyChallengeIds(new Date('2026-03-09'));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('Event to Tracking Types Mapping', () => {
  it('all event types have at least one tracking type', () => {
    for (const [_event, types] of Object.entries(EVENT_TO_TRACKING_TYPES)) {
      expect(types.length).toBeGreaterThan(0);
    }
  });

  it('prediction_trade maps to prediction-related tracking types', () => {
    const types = EVENT_TO_TRACKING_TYPES.prediction_trade;
    expect(types).toContain('prediction_trade_count');
    expect(types).toContain('total_trade_count');
  });

  it('agent_created maps to agent_count', () => {
    const types = EVENT_TO_TRACKING_TYPES.agent_created;
    expect(types).toContain('agent_count');
  });
});
