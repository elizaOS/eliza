import { describe, expect, it } from 'bun:test';
import { sortPerpsForScreener } from '../../../../apps/web/src/app/markets/_lib/sortPerpsForScreener';
import type { PerpMarket } from '../../../../apps/web/src/types/markets';

function mockPerp(
  ticker: string,
  volume24h: number,
  changePercent24h: number,
  opts?: Partial<PerpMarket>
): PerpMarket {
  return {
    ticker,
    organizationId: 'org',
    name: ticker,
    currentPrice: 100,
    change24h: changePercent24h,
    changePercent24h,
    high24h: 100,
    low24h: 100,
    volume24h,
    openInterest: 1000,
    fundingRate: {
      rate: 0.01,
      nextFundingTime: new Date().toISOString(),
      predictedRate: 0.01,
    },
    maxLeverage: 10,
    minOrderSize: 1,
    ...opts,
  };
}

describe('sortPerpsForScreener', () => {
  const markets = [
    mockPerp('LOW', 100, 1),
    mockPerp('HIGH_VOL', 900, 2),
    mockPerp('BIG_MOVE', 200, 50),
  ];

  it('volume24h desc sorts by volume descending', () => {
    const out = sortPerpsForScreener(
      markets,
      { key: 'volume24h', dir: 'desc' },
      10
    );
    expect(out[0]?.ticker).toBe('HIGH_VOL');
    expect(out[1]?.ticker).toBe('BIG_MOVE');
    expect(out[2]?.ticker).toBe('LOW');
  });

  it('asset asc sorts alphabetically by ticker', () => {
    const out = sortPerpsForScreener(markets, { key: 'asset', dir: 'asc' }, 10);
    expect(out[0]?.ticker).toBe('BIG_MOVE');
    expect(out[1]?.ticker).toBe('HIGH_VOL');
    expect(out[2]?.ticker).toBe('LOW');
  });

  it('asset desc sorts reverse-alphabetically', () => {
    const out = sortPerpsForScreener(
      markets,
      { key: 'asset', dir: 'desc' },
      10
    );
    expect(out[0]?.ticker).toBe('LOW');
    expect(out[2]?.ticker).toBe('BIG_MOVE');
  });

  it('change24h desc sorts by change percent descending', () => {
    const out = sortPerpsForScreener(
      markets,
      { key: 'change24h', dir: 'desc' },
      10
    );
    expect(out[0]?.ticker).toBe('BIG_MOVE');
  });

  it('change24h asc sorts by change percent ascending', () => {
    const out = sortPerpsForScreener(
      markets,
      { key: 'change24h', dir: 'asc' },
      10
    );
    expect(out[0]?.ticker).toBe('LOW');
  });

  it('trending desc gives highest score to high-volume+high-change markets', () => {
    const out = sortPerpsForScreener(
      markets,
      { key: 'trending', dir: 'desc' },
      10
    );
    expect(out[0]?.ticker).toBe('HIGH_VOL');
  });

  it('price desc sorts by price descending', () => {
    const data = [
      mockPerp('CHEAP', 100, 0, { currentPrice: 5 }),
      mockPerp('MID', 100, 0, { currentPrice: 50 }),
      mockPerp('PRICEY', 100, 0, { currentPrice: 500 }),
    ];
    const out = sortPerpsForScreener(data, { key: 'price', dir: 'desc' }, 10);
    expect(out[0]?.ticker).toBe('PRICEY');
    expect(out[2]?.ticker).toBe('CHEAP');
  });

  it('openInterest desc sorts by OI descending', () => {
    const data = [
      mockPerp('LOW_OI', 100, 0, { openInterest: 10 }),
      mockPerp('HIGH_OI', 100, 0, { openInterest: 9999 }),
    ];
    const out = sortPerpsForScreener(
      data,
      { key: 'openInterest', dir: 'desc' },
      10
    );
    expect(out[0]?.ticker).toBe('HIGH_OI');
  });

  it('funding desc sorts by funding rate descending', () => {
    const data = [
      mockPerp('NEG_FR', 100, 0, {
        fundingRate: { rate: -0.05, nextFundingTime: '', predictedRate: 0 },
      }),
      mockPerp('POS_FR', 100, 0, {
        fundingRate: { rate: 0.1, nextFundingTime: '', predictedRate: 0 },
      }),
    ];
    const out = sortPerpsForScreener(data, { key: 'funding', dir: 'desc' }, 10);
    expect(out[0]?.ticker).toBe('POS_FR');
  });

  it('respects maxRows', () => {
    const out = sortPerpsForScreener(
      markets,
      { key: 'volume24h', dir: 'desc' },
      2
    );
    expect(out).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    const out = sortPerpsForScreener([], { key: 'trending', dir: 'desc' }, 10);
    expect(out).toHaveLength(0);
  });
});
