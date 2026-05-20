import { describe, expect, it } from 'bun:test';
import {
  calculateActivityBonus,
  calculateArcStateMultiplier,
  calculateRecencyScore,
  calculateResolutionBoost,
  calculateStoryScore,
  calculateTotalEngagement,
} from './scoring';

/**
 * Tests for Narrative Feed API - Story Scoring Algorithm
 *
 * These tests verify that the narrative story scoring algorithm
 * correctly weights engagement, recency decay, and activity bonus.
 *
 * Scoring formula:
 *   storyScore = totalEngagement * 0.5 + recencyScore * 0.35 + activityBonus * 0.15
 *   totalEngagement = sum(likes*1 + comments*2 + shares*3)
 *   recencyScore    = Math.exp(-hoursOld / 12)   // 12h half-life on newest post
 *   activityBonus   = Math.min(postCount / 10, 1)
 */

describe('calculateTotalEngagement', () => {
  it('weights shares > comments > likes', () => {
    expect(calculateTotalEngagement(0, 0, 1)).toBeGreaterThan(
      calculateTotalEngagement(0, 1, 0)
    );
    expect(calculateTotalEngagement(0, 1, 0)).toBeGreaterThan(
      calculateTotalEngagement(1, 0, 0)
    );
  });

  it('sums correctly: 5*1 + 3*2 + 2*3 = 17', () => {
    expect(calculateTotalEngagement(5, 3, 2)).toBe(17);
  });

  it('returns 0 for no engagement', () => {
    expect(calculateTotalEngagement(0, 0, 0)).toBe(0);
  });
});

describe('calculateRecencyScore', () => {
  it('returns ~1.0 for a post right now', () => {
    expect(calculateRecencyScore(new Date())).toBeCloseTo(1.0, 2);
  });

  it('returns ~0.5 for a post 12 hours old (half-life)', () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    expect(calculateRecencyScore(twelveHoursAgo)).toBeCloseTo(0.5, 1);
  });

  it('decays monotonically', () => {
    const now = Date.now();
    const s1 = calculateRecencyScore(new Date(now - 1 * 3600_000));
    const s6 = calculateRecencyScore(new Date(now - 6 * 3600_000));
    const s24 = calculateRecencyScore(new Date(now - 24 * 3600_000));
    expect(s1).toBeGreaterThan(s6);
    expect(s6).toBeGreaterThan(s24);
  });

  it('is always positive', () => {
    expect(
      calculateRecencyScore(new Date(Date.now() - 200 * 3600_000))
    ).toBeGreaterThan(0);
  });
});

describe('calculateActivityBonus', () => {
  it('returns 0 for 0 posts', () => expect(calculateActivityBonus(0)).toBe(0));

  it('caps at 1.0 for ≥10 posts', () => {
    expect(calculateActivityBonus(10)).toBe(1);
    expect(calculateActivityBonus(50)).toBe(1);
  });

  it('scales linearly below cap', () =>
    expect(calculateActivityBonus(5)).toBeCloseTo(0.5, 5));
});

describe('calculateStoryScore', () => {
  it('ranks high-engagement recent story above low-engagement story', () => {
    const now = new Date();
    expect(calculateStoryScore(50, 20, 10, 8, now)).toBeGreaterThan(
      calculateStoryScore(1, 0, 0, 1, now)
    );
  });

  it('ranks recent story above stale story with identical engagement', () => {
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 3600_000);
    expect(calculateStoryScore(10, 5, 2, 5, now)).toBeGreaterThan(
      calculateStoryScore(10, 5, 2, 5, old)
    );
  });

  it('gives activity bonus to stories with many posts', () => {
    const now = new Date();
    expect(calculateStoryScore(0, 0, 0, 10, now)).toBeGreaterThan(
      calculateStoryScore(0, 0, 0, 1, now)
    );
  });
});

describe('calculateArcStateMultiplier', () => {
  it('returns 1.0 for null (no arc data)', () => {
    expect(calculateArcStateMultiplier(null)).toBe(1.0);
  });

  it('returns 1.0 for setup state (neutral)', () => {
    expect(calculateArcStateMultiplier('setup')).toBe(1.0);
  });

  it('crisis > climax > revelation > escalation > active > tension', () => {
    expect(calculateArcStateMultiplier('crisis')).toBeGreaterThan(
      calculateArcStateMultiplier('climax')
    );
    expect(calculateArcStateMultiplier('climax')).toBeGreaterThan(
      calculateArcStateMultiplier('revelation')
    );
    expect(calculateArcStateMultiplier('revelation')).toBeGreaterThan(
      calculateArcStateMultiplier('escalation')
    );
    expect(calculateArcStateMultiplier('escalation')).toBeGreaterThan(
      calculateArcStateMultiplier('active')
    );
    expect(calculateArcStateMultiplier('active')).toBeGreaterThan(
      calculateArcStateMultiplier('tension')
    );
  });

  it('resolution < resolving < setup (winding-down states rank lower)', () => {
    expect(calculateArcStateMultiplier('resolution')).toBeLessThan(
      calculateArcStateMultiplier('resolving')
    );
    expect(calculateArcStateMultiplier('resolving')).toBeLessThan(
      calculateArcStateMultiplier('setup')
    );
  });

  it('crisis story outranks identical setup story', () => {
    const now = new Date();
    const base = calculateStoryScore(10, 5, 2, 5, now);
    const crisis = base * calculateArcStateMultiplier('crisis');
    const setup = base * calculateArcStateMultiplier('setup');
    expect(crisis).toBeGreaterThan(setup);
  });

  it('daily market phases return 1.0 (neutral)', () => {
    expect(calculateArcStateMultiplier('morning')).toBe(1.0);
    expect(calculateArcStateMultiplier('midday')).toBe(1.0);
    expect(calculateArcStateMultiplier('afternoon')).toBe(1.0);
    expect(calculateArcStateMultiplier('evening')).toBe(1.0);
  });
});

describe('calculateResolutionBoost', () => {
  it('returns 1.0 for a date in the past (expired)', () => {
    const past = new Date(Date.now() - 1000 * 60 * 60);
    expect(calculateResolutionBoost(past)).toBe(1.0);
  });

  it('returns 1.4 for a date within 6 hours (peak urgency)', () => {
    const soon = new Date(Date.now() + 1000 * 60 * 60 * 3); // 3h from now
    expect(calculateResolutionBoost(soon)).toBe(1.4);
  });

  it('returns 1.25 for a date within 24 hours (imminent)', () => {
    const tomorrow = new Date(Date.now() + 1000 * 60 * 60 * 12); // 12h from now
    expect(calculateResolutionBoost(tomorrow)).toBe(1.25);
  });

  it('returns 1.1 for a date within 72 hours (approaching)', () => {
    const twodays = new Date(Date.now() + 1000 * 60 * 60 * 48); // 48h from now
    expect(calculateResolutionBoost(twodays)).toBe(1.1);
  });

  it('returns 1.0 for a date far in the future (no urgency)', () => {
    const nextWeek = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    expect(calculateResolutionBoost(nextWeek)).toBe(1.0);
  });
});
