import { v4 as uuidv4 } from 'uuid';
import { Agent, Entity, World, UUID, Role } from '@elizaos/core';

// Test IDs
export const worldTestAgentId = uuidv4() as UUID;
export const worldTestEntityId = uuidv4() as UUID;

// Test data for world integration tests
export const worldTestAgent: Agent = {
  id: worldTestAgentId,
  name: 'World Test Agent',
  bio: 'Test agent for world integration tests',
  settings: {
    profile: {
      short_description: 'Test agent for world integration tests',
    },
  },
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
};

export const worldTestEntity: Entity = {
  id: worldTestEntityId,
  names: ['World Test Entity'],
  agentId: worldTestAgentId,
  components: [],
  metadata: {
    type: 'user',
  },
};

// Basic test worlds
export const worldTestWorlds: World[] = [
  {
    id: uuidv4() as UUID,
    agentId: worldTestAgentId,
    name: 'Test World 1',
    serverId: 'test-server-1',
    metadata: {
      ownership: {
        ownerId: worldTestEntityId,
      },
      roles: {
        [worldTestEntityId]: Role.OWNER,
      },
    },
  },
  {
    id: uuidv4() as UUID,
    agentId: worldTestAgentId,
    name: 'Test World 2',
    serverId: 'test-server-2',
    metadata: {
      ownership: {
        ownerId: worldTestEntityId,
      },
    },
  },
  {
    id: uuidv4() as UUID,
    agentId: worldTestAgentId,
    name: 'Test World 3',
    serverId: 'test-server-3',
    metadata: {
      custom: 'value',
      tags: ['test', 'integration'],
    },
  },
];
