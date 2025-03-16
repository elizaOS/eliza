import type { IAgentRuntime } from '@elizaos/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientBase } from '../src/base';
import type { TwitterConfig } from '../src/environment';

// TODO: Probably won't work with focus on runtime.getSetting() due to lack of defaults

describe('Twitter Client Base', () => {
  let mockRuntime: IAgentRuntime;
  let mockConfig: TwitterConfig;

  beforeEach(() => {
    mockRuntime = {
      env: {
        TWITTER_USERNAME: 'testuser',
        TWITTER_DRY_RUN: 'true',
        TWITTER_POST_INTERVAL_MIN: '90',
        TWITTER_POST_INTERVAL_MAX: '180',
        TWITTER_ENABLE_ACTION_PROCESSING: 'true',
        TWITTER_POST_IMMEDIATELY: 'false',
      },
      getEnv: function (key: string) {
        return this.env[key] || null;
      },
      getSetting: function (key: string) {
        return this.env[key] || null;
      },
      character: {
        style: {
          all: ['Test style 1', 'Test style 2'],
          post: ['Post style 1', 'Post style 2'],
        },
      },
    } as unknown as IAgentRuntime;

    mockConfig = {
      TWITTER_USERNAME: 'testuser',
      TWITTER_DRY_RUN: true,
      TWITTER_SPACES_ENABLE: false,
      TWITTER_TARGET_USERS: [],
      TWITTER_PASSWORD: 'hashedpassword',
      TWITTER_EMAIL: 'test@example.com',
      TWITTER_2FA_SECRET: '',
      TWITTER_RETRY_LIMIT: 5,
      TWITTER_POLL_INTERVAL: 120,
      TWITTER_ENABLE_POST_GENERATION: true,
      TWITTER_POST_INTERVAL_MIN: 90,
      TWITTER_POST_INTERVAL_MAX: 180,
      TWITTER_POST_IMMEDIATELY: false,
    };
  });

  it('should create instance with correct configuration', () => {
    const client = new ClientBase(mockRuntime, mockConfig);
    expect(client).toBeDefined();
    expect(mockRuntime.getSetting('TWITTER_USERNAME')).toBe('testuser');
    expect(client.state.TWITTER_USERNAME).toBe('testuser');
    expect(mockRuntime.getSetting('TWITTER_DRY_RUN')).toBe('true');
    expect(client.state.TWITTER_DRY_RUN).toBe(true);
  });

  it('should initialize with correct post intervals', () => {
    const client = new ClientBase(mockRuntime, mockConfig);
    expect(mockRuntime.getSetting('TWITTER_POST_INTERVAL_MIN')).toBe('90');
    expect(client.state.TWITTER_POST_INTERVAL_MIN).toBe(90);
    expect(mockRuntime.getSetting('TWITTER_POST_INTERVAL_MAX')).toBe('180');
    expect(client.state.TWITTER_POST_INTERVAL_MAX).toBe(180);
  });
});
