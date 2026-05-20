import { describe, expect, test } from 'bun:test';
import { groupResolvedMarketOutcomes } from '../../../apps/web/src/lib/services/market-resolution-notifications';

describe('groupResolvedMarketOutcomes', () => {
  test('aggregates direct positions for the same holder and market', () => {
    const outcomes = groupResolvedMarketOutcomes([
      {
        holderId: 'user-1',
        ownerUserId: 'user-1',
        marketId: 'market-1',
        marketName: 'Will ETH break $5k?',
        points: 12.5,
        agentName: null,
      },
      {
        holderId: 'user-1',
        ownerUserId: 'user-1',
        marketId: 'market-1',
        marketName: 'Will ETH break $5k?',
        points: -2.25,
        agentName: null,
      },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ownerUserId: 'user-1',
      holderId: 'user-1',
      marketId: 'market-1',
      points: 10.25,
      outcome: 'win',
      dedupeKey: 'market_resolved:market-1:user-1',
      deepLink: '/markets/predictions/market-1',
    });
  });

  test('derives outcome from the final aggregated points total', () => {
    const outcomes = groupResolvedMarketOutcomes([
      {
        holderId: 'user-1',
        ownerUserId: 'user-1',
        marketId: 'market-1',
        marketName: 'Will ETH break $5k?',
        points: 12.5,
        agentName: null,
      },
      {
        holderId: 'user-1',
        ownerUserId: 'user-1',
        marketId: 'market-1',
        marketName: 'Will ETH break $5k?',
        points: -18,
        agentName: null,
      },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ownerUserId: 'user-1',
      holderId: 'user-1',
      marketId: 'market-1',
      points: -5.5,
      outcome: 'loss',
      dedupeKey: 'market_resolved:market-1:user-1',
      deepLink: '/markets/predictions/market-1',
    });
  });

  test('treats a zero total as a win for notification grouping', () => {
    const outcomes = groupResolvedMarketOutcomes([
      {
        holderId: 'user-1',
        ownerUserId: 'user-1',
        marketId: 'market-3',
        marketName: 'Will SOL break $300?',
        points: 10,
        agentName: null,
      },
      {
        holderId: 'user-1',
        ownerUserId: 'user-1',
        marketId: 'market-3',
        marketName: 'Will SOL break $300?',
        points: -10,
        agentName: null,
      },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ownerUserId: 'user-1',
      holderId: 'user-1',
      marketId: 'market-3',
      points: 0,
      outcome: 'win',
      dedupeKey: 'market_resolved:market-3:user-1',
      deepLink: '/markets/predictions/market-3',
    });
  });

  test('keeps agent-held outcomes separate and attributes the agent name', () => {
    const outcomes = groupResolvedMarketOutcomes([
      {
        holderId: 'agent-9',
        ownerUserId: 'user-1',
        marketId: 'market-2',
        marketName: 'Will BTC close green?',
        points: -9,
        agentName: 'Ares',
      },
    ]);

    expect(outcomes).toEqual([
      {
        ownerUserId: 'user-1',
        holderId: 'agent-9',
        marketId: 'market-2',
        marketName: 'Will BTC close green?',
        points: -9,
        outcome: 'loss',
        agentName: 'Ares',
        deepLink: '/markets/predictions/market-2',
        dedupeKey: 'market_resolved:market-2:agent-9',
      },
    ]);
  });
});
