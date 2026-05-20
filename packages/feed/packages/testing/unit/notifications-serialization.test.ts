import { describe, expect, test } from 'bun:test';
import { serializeNotificationForApi } from '../../../apps/web/src/app/api/notifications/route';

describe('serializeNotificationForApi', () => {
  test('preserves structured notification data for market_resolved rows', () => {
    const serialized = serializeNotificationForApi({
      id: '123',
      type: 'market_resolved',
      title: 'Market resolved',
      actorId: null,
      actor: null,
      postId: null,
      commentId: null,
      chatId: null,
      groupId: null,
      inviteId: null,
      message: 'Will ETH break $5k? resolved for a 42-point win.',
      data: {
        marketId: 'market-1',
        marketName: 'Will ETH break $5k?',
        outcome: 'win',
        points: 42,
        deepLink: '/markets/predictions/market-1',
      },
      read: false,
      createdAt: new Date('2026-03-18T15:00:00.000Z'),
    });

    expect(serialized).toMatchObject({
      id: '123',
      type: 'market_resolved',
      title: 'Market resolved',
      message: 'Will ETH break $5k? resolved for a 42-point win.',
      data: {
        marketId: 'market-1',
        marketName: 'Will ETH break $5k?',
        outcome: 'win',
        points: 42,
        deepLink: '/markets/predictions/market-1',
      },
      read: false,
      createdAt: '2026-03-18T15:00:00.000Z',
    });
  });
});
