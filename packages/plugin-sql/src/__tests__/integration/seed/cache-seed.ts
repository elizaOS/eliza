/**
 * Seed data for cache integration tests
 */
import { type UUID, AgentStatus, type Agent } from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Default test agent settings for cache tests
 */
export const cacheTestAgentSettings = {
  id: v4() as UUID,
  name: 'Cache Test Agent',
  username: 'cache_test_agent',
  system: 'Test agent system prompt',
  bio: 'An agent for testing cache operations',
  enabled: true,
  status: AgentStatus.ACTIVE,
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  settings: {
    cacheTestSetting: 'cache test value',
  },
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as Agent;

/**
 * Test cache values
 */
export const testCacheEntries = {
  stringValue: {
    key: 'test_string',
    value: 'test value',
  },
  numberValue: {
    key: 'test_number',
    value: 42,
  },
  objectValue: {
    key: 'test_object',
    value: {
      name: 'Test Object',
      properties: {
        id: 1,
        active: true,
      },
      tags: ['test', 'cache', 'integration'],
    },
  },
  arrayValue: {
    key: 'test_array',
    value: [1, 2, 3, 'four', { five: 5 }],
  },
};

/**
 * Test cache with expiration settings
 */
export const testCacheWithExpiration = {
  expired: {
    key: 'expired_cache',
    value: 'This value has expired',
    // Set expiration to 1 hour in the past
    expiresAt: Date.now() - 60 * 60 * 1000,
  },
  notExpired: {
    key: 'not_expired_cache',
    value: 'This value has not expired',
    // Set expiration to 1 hour in the future
    expiresAt: Date.now() + 60 * 60 * 1000,
  },
};
