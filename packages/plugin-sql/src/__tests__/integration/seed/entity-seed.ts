/**
 * Seed data for entity integration tests
 */
import { type UUID, AgentStatus, type Agent } from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Default test agent settings for entity tests
 */
export const entityTestAgentSettings = {
  id: v4() as UUID,
  name: 'Entity Test Agent',
  username: 'entity_test_agent',
  system: 'Test agent system prompt',
  bio: 'An agent for testing entity operations',
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
    entityTestSetting: 'entity test value',
  },
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as Agent;

/**
 * Test entity data
 */
export const testEntities = {
  basicEntity: {
    id: v4() as UUID,
    names: ['Basic Entity'],
    metadata: {
      type: 'basic',
      description: 'A basic entity for testing',
    },
    agentId: entityTestAgentSettings.id as UUID,
  },
  complexEntity: {
    id: v4() as UUID,
    names: ['Complex Entity', 'Alternative Name'],
    metadata: {
      type: 'complex',
      description: 'A complex entity for testing',
      properties: {
        strength: 10,
        intelligence: 15,
        isSpecial: true,
      },
      tags: ['test', 'entity', 'complex'],
    },
    agentId: entityTestAgentSettings.id as UUID,
  },
  entityToUpdate: {
    id: v4() as UUID,
    names: ['Entity to Update'],
    metadata: {
      type: 'updatable',
      version: 1,
    },
    agentId: entityTestAgentSettings.id as UUID,
  },
  entityWithComponent: {
    id: v4() as UUID,
    names: ['Entity with Component'],
    metadata: {
      type: 'component-holder',
    },
    agentId: entityTestAgentSettings.id as UUID,
  },
};
