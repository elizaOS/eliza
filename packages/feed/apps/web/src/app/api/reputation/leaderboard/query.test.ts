import { describe, expect, it } from 'bun:test';
import {
  getReputationActivityCutoff,
  parseReputationLeaderboardQuery,
} from './query';

describe('parseReputationLeaderboardQuery', () => {
  it('applies defaults when params are omitted', () => {
    const result = parseReputationLeaderboardQuery(new URLSearchParams());

    expect(result.limit).toBe(100);
    expect(result.minGames).toBe(5);
    expect(result.timeRange).toBe('all');
  });

  it('parses supported time ranges', () => {
    const result = parseReputationLeaderboardQuery(
      new URLSearchParams({
        limit: '25',
        minGames: '3',
        timeRange: 'weekly',
      })
    );

    expect(result.limit).toBe(25);
    expect(result.minGames).toBe(3);
    expect(result.timeRange).toBe('weekly');
  });
});

describe('getReputationActivityCutoff', () => {
  it('returns null for all-time filtering', () => {
    expect(getReputationActivityCutoff('all')).toBeNull();
  });

  it('returns the expected cutoff date for activity windows', () => {
    const now = new Date('2026-03-09T12:00:00.000Z');

    expect(getReputationActivityCutoff('daily', now)?.toISOString()).toBe(
      '2026-03-08T12:00:00.000Z'
    );
    expect(getReputationActivityCutoff('weekly', now)?.toISOString()).toBe(
      '2026-03-02T12:00:00.000Z'
    );
    expect(getReputationActivityCutoff('monthly', now)?.toISOString()).toBe(
      '2026-02-07T12:00:00.000Z'
    );
  });
});
