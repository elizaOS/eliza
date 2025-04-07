// packages/plugin-twitter/src/tests/ClientBaseTestSuite.ts

import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { ClientBase } from './base';
import type { TwitterConfig } from './environment';
import { logger } from '@elizaos/core';

export class ClientBaseTestSuite implements TestSuite {
  name = 'twitter-client-base';

  private mockRuntime: IAgentRuntime;
  private mockConfig: TwitterConfig;

  constructor() {
    this.mockRuntime = {
      env: {
        TWITTER_USERNAME: 'testuser',
        TWITTER_DRY_RUN: 'true',
        TWITTER_POST_INTERVAL_MIN: '90',
        TWITTER_POST_INTERVAL_MAX: '180',
        TWITTER_ENABLE_ACTION_PROCESSING: 'true',
        TWITTER_POST_IMMEDIATELY: 'false',
      },
      getEnv: (key: string) => this.mockRuntime.env[key] || null,
      getSetting: (key: string) => this.mockRuntime.env[key] || null,
      character: {
        style: {
          all: ['Test style 1', 'Test style 2'],
          post: ['Post style 1', 'Post style 2'],
        },
      },
    } as unknown as IAgentRuntime;

    this.mockConfig = {
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
  }

  tests = [
    {
      name: 'Create instance with correct configuration',
      fn: this.testInstanceCreation.bind(this),
    },
    { name: 'Initialize with correct post intervals', fn: this.testPostIntervals.bind(this) },
  ];

  async testInstanceCreation() {
    const client = new ClientBase(this.mockRuntime, this.mockConfig);
    if (!client) throw new Error('ClientBase instance creation failed.');

    if (this.mockRuntime.getSetting('TWITTER_USERNAME') !== 'testuser') {
      throw new Error('TWITTER_USERNAME setting mismatch.');
    }

    if (client.state.TWITTER_USERNAME !== 'testuser') {
      throw new Error('Client state TWITTER_USERNAME mismatch.');
    }

    if (this.mockRuntime.getSetting('TWITTER_DRY_RUN') !== 'true') {
      throw new Error('TWITTER_DRY_RUN setting mismatch.');
    }

    if (client.state.TWITTER_DRY_RUN !== true) {
      throw new Error('Client state TWITTER_DRY_RUN mismatch.');
    }

    logger.success('ClientBase instance created with correct configuration.');
  }

  async testPostIntervals() {
    const client = new ClientBase(this.mockRuntime, this.mockConfig);

    if (this.mockRuntime.getSetting('TWITTER_POST_INTERVAL_MIN') !== '90') {
      throw new Error('TWITTER_POST_INTERVAL_MIN setting mismatch.');
    }

    if (client.state.TWITTER_POST_INTERVAL_MIN !== 90) {
      throw new Error('Client state TWITTER_POST_INTERVAL_MIN mismatch.');
    }

    if (this.mockRuntime.getSetting('TWITTER_POST_INTERVAL_MAX') !== '180') {
      throw new Error('TWITTER_POST_INTERVAL_MAX setting mismatch.');
    }

    if (client.state.TWITTER_POST_INTERVAL_MAX !== 180) {
      throw new Error('Client state TWITTER_POST_INTERVAL_MAX mismatch.');
    }

    logger.success('ClientBase initialized with correct post intervals.');
  }
}
