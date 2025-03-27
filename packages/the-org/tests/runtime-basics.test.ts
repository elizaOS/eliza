import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { 
  AgentRuntime,
  UUID,
  IDatabaseAdapter,
  AgentStatus
} from '@elizaos/core';

// Import the character for testing
import { character as communityManagerCharacter } from '../src/communityManager';

// Use the same mock pattern as core/tests/runtime.test.ts
/**
 * Mock database adapter for testing purposes.
 * Follows the pattern from core/__tests__/runtime.test.ts
 */
const mockDatabaseAdapter: IDatabaseAdapter = {
  db: {},
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getEntityById: vi.fn().mockResolvedValue(null),
  createEntity: vi.fn().mockResolvedValue(true),
  getMemories: vi.fn().mockResolvedValue([]),
  getMemoryById: vi.fn().mockResolvedValue(null),
  getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
  getMemoriesByIds: vi.fn().mockResolvedValue([]),
  getCachedEmbeddings: vi.fn().mockResolvedValue([]),
  log: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  createMemory: vi.fn().mockResolvedValue(uuidv4() as UUID),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  deleteAllMemories: vi.fn().mockResolvedValue(undefined),
  countMemories: vi.fn().mockResolvedValue(0),
  getRoom: vi.fn().mockResolvedValue(null),
  createRoom: vi.fn().mockResolvedValue(uuidv4() as UUID),
  deleteRoom: vi.fn().mockResolvedValue(undefined),
  getRoomsForParticipant: vi.fn().mockResolvedValue([]),
  getRoomsForParticipants: vi.fn().mockResolvedValue([]),
  addParticipant: vi.fn().mockResolvedValue(true),
  removeParticipant: vi.fn().mockResolvedValue(true),
  getParticipantsForEntity: vi.fn().mockResolvedValue([]),
  getParticipantsForRoom: vi.fn().mockResolvedValue([]),
  getParticipantUserState: vi.fn().mockResolvedValue(null),
  setParticipantUserState: vi.fn().mockResolvedValue(undefined),
  createRelationship: vi.fn().mockResolvedValue(true),
  getRelationship: vi.fn().mockResolvedValue(null),
  getRelationships: vi.fn().mockResolvedValue([]),
  updateRelationship: vi.fn().mockResolvedValue(undefined),
  updateMemory: vi.fn().mockResolvedValue(undefined),
  getLogs: vi.fn().mockResolvedValue([]),
  deleteLog: vi.fn().mockResolvedValue(undefined),
  getAgent: vi.fn().mockImplementation((id) => {
    return Promise.resolve({
      id: id as UUID,
      name: communityManagerCharacter.name,
      status: AgentStatus.ACTIVE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: communityManagerCharacter.bio,
      agentId: id as UUID,
    });
  }),
  getAgents: vi.fn().mockResolvedValue([]),
  createAgent: vi.fn().mockResolvedValue(true),
  updateAgent: vi.fn().mockResolvedValue(true),
  deleteAgent: vi.fn().mockResolvedValue(true),
  ensureAgentExists: vi.fn().mockResolvedValue(undefined),
  ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
  getEntitiesForRoom: vi.fn().mockResolvedValue([]),
  updateEntity: vi.fn().mockResolvedValue(undefined),
  getComponent: vi.fn().mockResolvedValue(null),
  getComponents: vi.fn().mockResolvedValue([]),
  createComponent: vi.fn().mockResolvedValue(true),
  updateComponent: vi.fn().mockResolvedValue(undefined),
  deleteComponent: vi.fn().mockResolvedValue(undefined),
  createWorld: vi.fn().mockResolvedValue(uuidv4() as UUID),
  getWorld: vi.fn().mockResolvedValue(null),
  getAllWorlds: vi.fn().mockResolvedValue([]),
  updateWorld: vi.fn().mockResolvedValue(undefined),
  updateRoom: vi.fn().mockResolvedValue(undefined),
  getRooms: vi.fn().mockResolvedValue([]),
  getCache: vi.fn().mockResolvedValue(undefined),
  setCache: vi.fn().mockResolvedValue(true),
  deleteCache: vi.fn().mockResolvedValue(true),
  createTask: vi.fn().mockResolvedValue(uuidv4() as UUID),
  getTasks: vi.fn().mockResolvedValue([]),
  getTask: vi.fn().mockResolvedValue(null),
  getTasksByName: vi.fn().mockResolvedValue([]),
  updateTask: vi.fn().mockResolvedValue(undefined),
  deleteTask: vi.fn().mockResolvedValue(undefined),
};

/**
 * Basic runtime tests for Community Manager character
 */
describe('Community Manager Runtime Basics', () => {
  let runtime: AgentRuntime;
  
  // Silence console output during tests
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  
  beforeEach(() => {
    vi.clearAllMocks();
    console.warn = vi.fn();
    console.error = vi.fn();
    
    // Create a test character that doesn't use plugins
    const testCharacter = {
      ...communityManagerCharacter,
      plugins: [] // No plugins to avoid external dependencies
    };
    
    // Create runtime with ignoreBootstrap to skip plugin loading
    runtime = new AgentRuntime({
      character: testCharacter,
      adapter: mockDatabaseAdapter,
      agentId: uuidv4() as UUID,
      plugins: [],
      ignoreBootstrap: true // Skip plugin loading
    });
  });
  
  afterEach(async () => {
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    
    if (runtime) {
      await runtime.stop();
    }
  });
  
  it('should initialize successfully with minimal configuration', async () => {
    // Initialize the runtime
    await runtime.initialize();
    
    // Register some providers manually since we're using ignoreBootstrap
    runtime.registerProvider({
      name: 'SYSTEM_PROMPT',
      position: 0,
      get: async () => ({
        text: 'System prompt',
        values: { systemPrompt: 'System prompt' }
      })
    });
    
    runtime.registerProvider({
      name: 'CONVERSATION_HISTORY',
      position: 10,
      get: async () => ({
        text: 'Conversation history',
        values: { conversationHistory: 'Conversation history' }
      })
    });
    
    // Verify it initialized correctly
    expect(runtime.character.name).toBe(communityManagerCharacter.name);
    expect(runtime.agentId).toBeDefined();
    expect(runtime.providers.length).toBeGreaterThan(0);
    
    // Verify the mock adapter was called correctly
    expect(mockDatabaseAdapter.init).toHaveBeenCalled();
    expect(mockDatabaseAdapter.ensureAgentExists).toHaveBeenCalled();
    expect(mockDatabaseAdapter.getAgent).toHaveBeenCalled();
  });
  
  it('should allow registering providers', async () => {
    // Initialize the runtime
    await runtime.initialize();
    
    // Register a test provider
    runtime.registerProvider({
      name: 'TEST_PROVIDER',
      position: 20,
      get: async () => ({
        text: 'Test provider',
        values: { testProvider: 'Test provider' }
      })
    });
    
    // Verify provider registration
    const providers = runtime.providers;
    expect(providers.length).toBeGreaterThan(0);
    
    // Check for the test provider
    const providerNames = providers.map(p => p.name);
    expect(providerNames).toContain('TEST_PROVIDER');
  });
}); 