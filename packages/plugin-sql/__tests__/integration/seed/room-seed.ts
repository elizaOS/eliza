import { v4 as uuidv4 } from 'uuid';
import { Room, Entity, Agent, World, UUID, ChannelType } from '@elizaos/core';

// Test IDs
export const roomTestAgentId = uuidv4() as UUID;
export const roomTestEntityId = uuidv4() as UUID;
export const roomTestWorldId = uuidv4() as UUID;
export const roomTestRoomId = uuidv4() as UUID;
export const roomTestRoom2Id = uuidv4() as UUID;

// Test data for room integration tests
export const roomTestAgent: Agent = {
  id: roomTestAgentId,
  name: 'Room Test Agent',
  bio: 'Test agent for room integration tests',
  settings: {
    profile: {
      short_description: 'Test agent for room integration tests',
    },
  },
  createdAt: new Date().getTime(),
  updatedAt: new Date().getTime(),
};

export const roomTestEntity: Entity = {
  id: roomTestEntityId,
  names: ['Room Test Entity'],
  agentId: roomTestAgentId,
  components: [],
  metadata: {
    type: 'user',
    worldId: roomTestWorldId,
  },
};

export const roomTestWorld: World = {
  id: roomTestWorldId,
  agentId: roomTestAgentId,
  name: 'Room Test World',
  serverId: 'test-server',
  metadata: {},
};

// Basic room test objects
export const roomTestRooms: Room[] = [
  {
    id: roomTestRoomId,
    name: 'Room Test Room 1',
    agentId: roomTestAgentId,
    source: 'test',
    type: ChannelType.GROUP,
    worldId: roomTestWorldId,
    metadata: {
      description: 'Test description for room 1',
      tags: ['test', 'integration'],
    },
  },
  {
    id: roomTestRoom2Id,
    name: 'Room Test Room 2',
    agentId: roomTestAgentId,
    source: 'test',
    type: ChannelType.DM,
    worldId: roomTestWorldId,
    channelId: 'test-channel-id',
    serverId: 'test-server-id',
    metadata: {
      description: 'Test description for room 2',
      tags: ['integration'],
    },
  },
  {
    id: uuidv4() as UUID,
    name: 'Room Test Room 3',
    agentId: roomTestAgentId,
    source: 'discord',
    type: ChannelType.GROUP,
    worldId: roomTestWorldId,
    metadata: {
      description: 'Test description for room 3',
      isPrivate: true,
    },
  },
];

// Helper function to create a modified room for update tests
export const createModifiedRoom = (room: Room): Room => {
  return {
    ...room,
    name: `${room.name} - Updated`,
    metadata: {
      ...(room.metadata as Record<string, unknown>),
      updated: true,
      timestamp: Date.now(),
    },
  };
};
