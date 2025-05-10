/**
 * Seed data for agent integration tests
 */
import { type UUID, type Agent, AgentStatus } from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Default test agent settings for agent tests
 */
export const testAgentSettings = {
  id: v4() as UUID,
  name: 'Agent Test Agent',
  username: 'agent_test_agent',
  system: 'Test agent system prompt',
  bio: 'An agent for testing agent operations',
  enabled: true,
  status: AgentStatus.ACTIVE,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  settings: {
    agentTestSetting: 'agent test value',
  },
  style: {
    all: [],
    chat: [],
    post: [],
  },
} as Agent;
