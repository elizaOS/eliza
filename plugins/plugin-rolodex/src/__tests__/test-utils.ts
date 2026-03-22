import { vi } from 'vitest';
import {
  stringToUuid,
  type IAgentRuntime,
  type Memory,
  type State,
  type Entity,
  type Room,
  type Metadata,
  type UUID,
} from '@elizaos/core';

export function createMockRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
  const mockRoom: Room = {
    id: stringToUuid('test-room'),
    agentId: stringToUuid('test-agent'),
    source: 'test',
    type: 'SELF' as any, // Using any to avoid importing ChannelType enum
  };

  const mockEntity: Entity = {
    id: stringToUuid('test-entity'),
    agentId: stringToUuid('test-agent'),
    names: ['Test Entity'],
    metadata: {},
  };

  return {
    agentId: stringToUuid('test-agent'),
    // Memory operations
    getMemories: vi.fn(() => Promise.resolve([])),
    saveMemory: vi.fn(() => Promise.resolve(undefined)),
    updateMemory: vi.fn(() => Promise.resolve(undefined)),

    // Entity operations
    getEntity: vi.fn(() => Promise.resolve(mockEntity)),
    getEntityById: vi.fn(() => Promise.resolve(mockEntity)),
    updateEntity: vi.fn(() => Promise.resolve(undefined)),
    createEntity: vi.fn(() => Promise.resolve(mockEntity)),

    // Room operations
    getRoom: vi.fn(() => Promise.resolve(mockRoom)),
    getRooms: vi.fn(() => Promise.resolve([mockRoom])),
    createRoom: vi.fn(() => Promise.resolve(mockRoom)),
    getEntitiesForRoom: vi.fn(() => Promise.resolve([mockEntity])),

    // Relationship operations
    getRelationships: vi.fn(() => Promise.resolve([])),
    saveRelationships: vi.fn(() => Promise.resolve(undefined)),
    updateRelationship: vi.fn(() => Promise.resolve(undefined)),
    getRelationshipsByEntityIds: vi.fn(() => Promise.resolve([])),

    // Component operations
    getComponents: vi.fn(() => Promise.resolve([])),
    createComponent: vi.fn(() => Promise.resolve({
      id: stringToUuid('test-component'),
      type: 'test',
      agentId: stringToUuid('test-agent'),
      entityId: stringToUuid('test-entity'),
      roomId: stringToUuid('test-room'),
      worldId: stringToUuid('test-world'),
      sourceEntityId: stringToUuid('test-agent'),
      data: {} as Metadata,
      createdAt: Date.now(),
    })),
    updateComponent: vi.fn(() => Promise.resolve(undefined)),
    deleteComponent: vi.fn(() => Promise.resolve(undefined)),

    // Task operations
    getTasks: vi.fn(() => Promise.resolve([])),
    getTask: vi.fn(() => Promise.resolve(null)),
    createTask: vi.fn((task) => Promise.resolve({
      ...task,
      id: stringToUuid(`task-${Date.now()}`),
      createdAt: Date.now(),
    })),
    updateTask: vi.fn(() => Promise.resolve(undefined)),
    deleteTask: vi.fn(() => Promise.resolve(undefined)),

    // Service operations
    getService: vi.fn(() => null),

    // Model operations
    useModel: vi.fn(() => Promise.resolve('test response')),

    // Settings
    getSetting: vi.fn(() => undefined),

    // Event operations
    emitEvent: vi.fn(() => Promise.resolve(undefined)),

    // Other operations
    getParticipantUserState: vi.fn(() => Promise.resolve(null)),
    setParticipantUserState: vi.fn(() => Promise.resolve(undefined)),

    ...overrides,
  } as unknown as IAgentRuntime;
}

export function createMockMemory(overrides?: Partial<Memory>): Memory {
  return {
    id: stringToUuid('test-message'),
    entityId: stringToUuid('test-user'),
    content: {
      text: 'Test message',
    },
    roomId: stringToUuid('test-room'),
    createdAt: Date.now(),
    ...overrides,
  };
}

export function createMockState(overrides?: Partial<State>): State {
  return {
    values: {},
    data: {},
    text: 'Test message',
    agentId: stringToUuid('test-agent'),
    roomId: stringToUuid('test-room'),
    userId: stringToUuid('test-user'),
    messages: [],
    memories: [],
    goals: [],
    facts: [],
    knowledge: [],
    recentMessages: [],
    recentMessagesData: [],
    bio: 'Test agent bio',
    senderName: 'Test User',
    ...overrides,
  };
}

export function createMockEntity(name: string, id?: UUID): Entity {
  return {
    id: id || stringToUuid(`entity-${name}`),
    agentId: stringToUuid('test-agent'),
    names: [name],
    metadata: {},
  };
}
