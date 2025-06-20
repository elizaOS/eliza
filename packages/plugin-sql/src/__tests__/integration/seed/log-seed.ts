/**
 * Seed data for log integration tests
 */
import { type UUID, type Log, ChannelType, AgentStatus, type Agent } from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Default test agent settings for log tests
 */
export const logTestAgentSettings = {
  id: v4() as UUID,
  name: 'Log Test Agent',
  username: 'log_test_agent',
  system: 'Test agent system prompt',
  bio: 'An agent for testing log operations',
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
    logTestSetting: 'log test value',
  },
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as Agent;

/**
 * Test world for log tests
 */
export const logTestWorld = {
  id: v4() as UUID,
  agentId: logTestAgentSettings.id,
  serverId: v4() as UUID,
  name: 'Log Test World',
  description: 'A world for log integration tests',
  metadata: {},
};

/**
 * Test entity for log tests
 */
export const logTestEntity = {
  id: v4() as UUID,
  names: ['Log Test Entity'],
  agentId: logTestAgentSettings.id,
  metadata: {},
};

/**
 * Test room for log tests
 */
export const logTestRoom = {
  id: v4() as UUID,
  name: 'Log Test Room',
  type: ChannelType.DM,
  agentId: logTestAgentSettings.id,
  worldId: logTestWorld.id,
  source: 'log-test',
  metadata: {},
};

/**
 * Test logs
 */
export const logTestLogs = {
  basic: {
    id: v4() as UUID,
    entityId: logTestEntity.id,
    roomId: logTestRoom.id,
    body: { message: 'Test log message', data: { key: 'value' } },
    type: 'test_log',
    createdAt: new Date(),
  } as Log,
  withMetadata: {
    id: v4() as UUID,
    entityId: logTestEntity.id,
    roomId: logTestRoom.id,
    body: {
      message: 'Log with extra metadata',
      metadata: {
        priority: 'high',
        source: 'test_suite',
      },
    },
    type: 'metadata_log',
    createdAt: new Date(),
  } as Log,
};
