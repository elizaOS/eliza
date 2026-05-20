import { describe, expect, it } from 'bun:test';
import { parseLeaderboardQuery } from './query';

describe('parseLeaderboardQuery', () => {
  it('parses supported leaderboard params', () => {
    const result = parseLeaderboardQuery(
      new URLSearchParams({
        page: '2',
        pageSize: '25',
        metric: 'trading',
        type: 'team',
        userId: 'user-1',
      })
    );

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(25);
    expect(result.metric).toBe('trading');
    expect(result.type).toBe('team');
    expect(result.userId).toBe('user-1');
  });

  it('rejects silently-ignored params with a 400-style error', () => {
    expect(() =>
      parseLeaderboardQuery(
        new URLSearchParams({
          sortBy: 'score',
          timeRange: 'weekly',
          search: 'alice',
        })
      )
    ).toThrow('Unsupported query parameters: sortBy, timeRange, search');
  });

  it('rejects legacy leaderboard params from the canonical contract', () => {
    expect(() =>
      parseLeaderboardQuery(
        new URLSearchParams({
          metric: 'reputation',
          type: 'wallet',
          minPoints: '500',
          pointsType: 'total',
        })
      )
    ).toThrow('Unsupported query parameters: minPoints, pointsType');
  });
});
