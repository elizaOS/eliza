import type { IAgentRuntime } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import { validateTwitterConfig } from '../src/environment';

/**
 * Environment configuration object for Twitter bot.
 * Contains various settings such as username, post interval, email, password, etc.
 */
const env = {
  TWITTER_USERNAME: 'testuser123',
  TWITTER_DRY_RUN: 'true',
  TWITTER_SPACES_ENABLE: 'false',
  TWITTER_TARGET_USERS: 'name1,name2,name3',
  TWITTER_POST_INTERVAL_MIN: '90',
  TWITTER_POST_INTERVAL_MAX: '180',
  TWITTER_ENABLE_ACTION_PROCESSING: 'false',
  TWITTER_POST_IMMEDIATELY: 'false',
  TWITTER_EMAIL: 'test@example.com',
  TWITTER_PASSWORD: 'hashedpassword',
  TWITTER_2FA_SECRET: '',
  TWITTER_POLL_INTERVAL: '120',
  TWITTER_RETRY_LIMIT: '5',
};

describe('Twitter Environment Configuration', () => {
  const mockRuntime: IAgentRuntime = {
    env,
    getEnv: function (key: string) {
      return this.env[key] || null;
    },
    getSetting: function (key: string) {
      return this.env[key] || null;
    },
  } as unknown as IAgentRuntime;

  it('should validate correct configuration', async () => {
    const config = await validateTwitterConfig(mockRuntime);
    expect(config).toBeDefined();
    expect(config.TWITTER_USERNAME).toBe('testuser123');
    expect(config.TWITTER_DRY_RUN).toBe(true);
    expect(config.TWITTER_SPACES_ENABLE).toBe(false);
    expect(config.TWITTER_POST_INTERVAL_MIN).toBe(90);
    expect(config.TWITTER_POST_INTERVAL_MAX).toBe(180);
    expect(config.TWITTER_POST_IMMEDIATELY).toBe(false);
  });

  it('should validate wildcard username', async () => {
    const wildcardRuntime = {
      ...mockRuntime,
      env: {
        ...env,
        TWITTER_USERNAME: '*',
      },
      getEnv: function (key: string) {
        return this.env[key] || null;
      },
      getSetting: function (key: string) {
        return this.env[key] || null;
      },
    } as IAgentRuntime;

    const config = await validateTwitterConfig(wildcardRuntime);
    expect(config.TWITTER_USERNAME).toBe('*');
  });

  it('should validate username with numbers and underscores', async () => {
    const validRuntime = {
      ...mockRuntime,
      env: {
        ...env,
        TWITTER_USERNAME: 'test_user_123',
      },
      getEnv: function (key: string) {
        return this.env[key] || null;
      },
      getSetting: function (key: string) {
        return this.env[key] || null;
      },
    } as IAgentRuntime;

    const config = await validateTwitterConfig(validRuntime);
    expect(config.TWITTER_USERNAME).toBe('test_user_123');
  });

  it('should use default values when optional configs are missing', async () => {
    const minimalRuntime = {
      env: {
        TWITTER_USERNAME: 'testuser',
        TWITTER_DRY_RUN: 'true',
        TWITTER_EMAIL: 'test@example.com',
        TWITTER_PASSWORD: 'hashedpassword',
        TWITTER_2FA_SECRET: '',
      },
      getEnv: function (key: string) {
        return this.env[key] || null;
      },
      getSetting: function (key: string) {
        return this.env[key] || null;
      },
    } as unknown as IAgentRuntime;

    const config = await validateTwitterConfig(minimalRuntime);
    expect(config).toBeDefined();
    expect(config.TWITTER_POST_INTERVAL_MIN).toBe(90);
    expect(config.TWITTER_POST_INTERVAL_MAX).toBe(180);
  });
});
