import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockExecute = mock(async () => [{ count: 0 }]);

const actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ...actualDb,
  buildCapitalBaseContributionSql: () => '0',
  db: {
    execute: mockExecute,
  },
}));

const moduleUrl = new URL(
  '../../api/src/services/trading-performance-service.ts',
  import.meta.url
);
moduleUrl.searchParams.set('test', 'trading-performance-date-normalization');
const { TradingPerformanceService } = await import(moduleUrl.href);

describe('TradingPerformanceService date normalization', () => {
  beforeEach(() => {
    mockExecute.mockClear();
    mockExecute.mockResolvedValue([{ count: 0 }]);
  });

  test('countWalletsAbove accepts cached ISO string dates', async () => {
    await expect(
      TradingPerformanceService.countWalletsAbove({
        id: 'user-1',
        createdAt: '2026-04-07T11:35:04.013Z',
        tradingReturn: '0.42',
      })
    ).resolves.toBe(0);

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  test('countTeamsAbove accepts cached ISO string dates', async () => {
    await expect(
      TradingPerformanceService.countTeamsAbove({
        id: 'team-1',
        createdAt: '2026-04-07T11:35:04.013Z',
        teamTradingReturn: '0.84',
      })
    ).resolves.toBe(0);

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
