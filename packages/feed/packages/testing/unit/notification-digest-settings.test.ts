import { describe, expect, test } from 'bun:test';
import { DEFAULT_NOTIFICATION_DIGEST_SETTINGS } from '@babylon/shared';

describe('DEFAULT_NOTIFICATION_DIGEST_SETTINGS', () => {
  test('matches the product defaults for new users', () => {
    expect(DEFAULT_NOTIFICATION_DIGEST_SETTINGS).toEqual({
      digestEnabled: true,
      frequency: 'daily',
      deliveryChannel: 'both',
    });
  });
});
