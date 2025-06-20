/**
 * Seed data for component integration tests
 */
import { type UUID, type Component, ChannelType, AgentStatus, type Agent } from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Default test agent settings for component tests
 */
export const componentTestAgentSettings = {
  id: v4() as UUID,
  name: 'Component Test Agent',
  username: 'component_test_agent',
  system: 'Test agent system prompt',
  bio: 'An agent for testing component operations',
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
    componentTestSetting: 'component test value',
  },
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as Agent;

/**
 * Test world for component tests
 */
export const componentTestWorld = {
  id: v4() as UUID,
  name: 'Component Test World',
  agentId: componentTestAgentSettings.id,
  serverId: 'component-test-server',
  metadata: {
    ownership: {
      ownerId: 'component-test-owner',
    },
  },
};

/**
 * Test entity for component tests
 */
export const componentTestEntity = {
  id: v4() as UUID,
  names: ['Component Test Entity'],
  agentId: componentTestAgentSettings.id,
  metadata: {},
};

/**
 * Secondary test entity for source entity references
 */
export const componentTestSourceEntity = {
  id: v4() as UUID,
  names: ['Component Test Source Entity'],
  agentId: componentTestAgentSettings.id,
  metadata: {},
};

/**
 * Test room for component tests
 */
export const componentTestRoom = {
  id: v4() as UUID,
  name: 'Component Test Room',
  type: ChannelType.DM,
  agentId: componentTestAgentSettings.id,
  source: 'component-test',
  worldId: componentTestWorld.id,
  metadata: {},
};

/**
 * Test components
 */
export const componentTestComponents = {
  basic: {
    id: v4() as UUID,
    entityId: componentTestEntity.id,
    agentId: componentTestAgentSettings.id,
    roomId: componentTestRoom.id,
    type: 'basic_component',
    data: { value: 'basic component data' },
    worldId: undefined as UUID | undefined,
    sourceEntityId: undefined as UUID | undefined,
    createdAt: Date.now(),
  } as Component,
  withWorldId: {
    id: v4() as UUID,
    entityId: componentTestEntity.id,
    agentId: componentTestAgentSettings.id,
    roomId: componentTestRoom.id,
    worldId: componentTestWorld.id,
    type: 'world_component',
    data: { worldValue: 42 },
    sourceEntityId: undefined as UUID | undefined,
    createdAt: Date.now(),
  } as Component,
  withSourceEntity: {
    id: v4() as UUID,
    entityId: componentTestEntity.id,
    agentId: componentTestAgentSettings.id,
    roomId: componentTestRoom.id,
    sourceEntityId: componentTestSourceEntity.id,
    type: 'source_component',
    data: { sourceValue: 'from source entity' },
    worldId: undefined as UUID | undefined,
    createdAt: Date.now(),
  } as Component,
};
