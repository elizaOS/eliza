import { mock } from 'bun:test';
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
    getMemories: mock(() => Promise.resolve([])),
    saveMemory: mock(() => Promise.resolve(undefined)),
    updateMemory: mock(() => Promise.resolve(undefined)),

    // Entity operations
    getEntity: mock(() => Promise.resolve(mockEntity)),
    getEntityById: mock(() => Promise.resolve(mockEntity)),
    updateEntity: mock(() => Promise.resolve(undefined)),
    createEntity: mock(() => Promise.resolve(mockEntity)),

    // Room operations
    getRoom: mock(() => Promise.resolve(mockRoom)),
    getRooms: mock(() => Promise.resolve([mockRoom])),
    createRoom: mock(() => Promise.resolve(mockRoom)),
    getEntitiesForRoom: mock(() => Promise.resolve([mockEntity])),

    // Relationship operations
    getRelationships: mock(() => Promise.resolve([])),
    saveRelationships: mock(() => Promise.resolve(undefined)),
    updateRelationship: mock(() => Promise.resolve(undefined)),
    getRelationshipsByEntityIds: mock(() => Promise.resolve([])),

    // Component operations
    getComponents: mock(() => Promise.resolve([])),
    createComponent: mock(() => Promise.resolve({
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
    updateComponent: mock(() => Promise.resolve(undefined)),
    deleteComponent: mock(() => Promise.resolve(undefined)),

    // Task operations
    getTasks: mock(() => Promise.resolve([])),
    getTask: mock(() => Promise.resolve(null)),
    createTask: mock((task) => Promise.resolve({
      ...task,
      id: stringToUuid(`task-${Date.now()}`),
      createdAt: Date.now(),
    })),
    updateTask: mock(() => Promise.resolve(undefined)),
    deleteTask: mock(() => Promise.resolve(undefined)),

    // Service operations
    getService: mock(() => null),

    // Model operations
    useModel: mock(() => Promise.resolve('test response')),

    // Settings
    getSetting: mock(() => undefined),

    // Event operations
    emitEvent: mock(() => Promise.resolve(undefined)),

    // Other operations
    getParticipantUserState: mock(() => Promise.resolve(null)),
    setParticipantUserState: mock(() => Promise.resolve(undefined)),

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
