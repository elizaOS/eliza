import { afterEach, describe, expect, it } from 'bun:test';

import {
  getNotificationEmailFromEnv,
  getPrivyAppIdFromEnv,
  getTrimmedEnv,
} from '../../api/src/env';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('api env helpers', () => {
  it('getTrimmedEnv returns undefined for missing or whitespace values', () => {
    delete process.env.PRIVY_APP_SECRET;
    expect(getTrimmedEnv('PRIVY_APP_SECRET')).toBeUndefined();

    process.env.PRIVY_APP_SECRET = '   ';
    expect(getTrimmedEnv('PRIVY_APP_SECRET')).toBeUndefined();
  });

  it('getTrimmedEnv trims configured values', () => {
    process.env.PRIVY_APP_SECRET = '  test-secret  ';
    expect(getTrimmedEnv('PRIVY_APP_SECRET')).toBe('test-secret');
  });

  it('getPrivyAppIdFromEnv prefers PRIVY_APP_ID and falls back to NEXT_PUBLIC_PRIVY_APP_ID', () => {
    process.env.PRIVY_APP_ID = 'server-app-id';
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'public-app-id';
    expect(getPrivyAppIdFromEnv()).toBe('server-app-id');

    process.env.PRIVY_APP_ID = '   ';
    expect(getPrivyAppIdFromEnv()).toBe('public-app-id');
  });

  it('getNotificationEmailFromEnv prefers NOTIFICATION_EMAIL_FROM and falls back to EMAIL_FROM', () => {
    process.env.NOTIFICATION_EMAIL_FROM = 'notify@babylon.market';
    process.env.EMAIL_FROM = 'legacy@babylon.market';
    expect(getNotificationEmailFromEnv()).toBe('notify@babylon.market');

    delete process.env.NOTIFICATION_EMAIL_FROM;
    expect(getNotificationEmailFromEnv()).toBe('legacy@babylon.market');
  });
});
