import { v4 as uuidv4 } from 'uuid';
import { Entity, Room, Agent, World, UUID, ChannelType } from '@elizaos/core';

// Test IDs
export const participantTestAgentId = uuidv4() as UUID;
export const participantTestEntityId = uuidv4() as UUID;
export const participantTestRoomId = uuidv4() as UUID;
export const participantTestWorldId = uuidv4() as UUID;

// Test data for participant integration tests
export const participantTestAgent: Agent = {
  id: participantTestAgentId,
  name: 'Participant Test Agent',
  bio: 'Test agent for participant integration tests',
  settings: {
    profile: {
      short_description: 'Test agent for participant integration tests',
    },
  },
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
};

export const participantTestEntity: Entity = {
  id: participantTestEntityId,
  names: ['Participant Test Entity'],
  agentId: participantTestAgentId,
  components: [],
  metadata: {
    type: 'user',
    worldId: participantTestWorldId,
  },
};

export const participantTestWorld: World = {
  id: participantTestWorldId,
  agentId: participantTestAgentId,
  name: 'Participant Test World',
  serverId: 'test-server',
  metadata: {},
};

export const participantTestRoom: Room = {
  id: participantTestRoomId,
  name: 'Participant Test Room',
  agentId: participantTestAgentId,
  source: 'test',
  type: ChannelType.GROUP,
  worldId: participantTestWorldId,
  metadata: {},
};
