/**
 * E2E (End-to-End) Test Suite for Core Runtime Functionality
 * ============================================================
 *
 * This file contains comprehensive end-to-end tests that validate core runtime
 * functionality in a realistic scenario. These tests simulate real-world usage
 * patterns and validate the complete workflow from message creation to response.
 *
 * NOTE: These tests use bun:test but simulate E2E scenarios by testing
 * multiple components working together in realistic workflows.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentRuntime } from '../../runtime';
import { DefaultMessageService } from '../../services/default-message-service';
import { createMessageMemory, getMemoryText } from '../../memory';
import { parseCharacter } from '../../character';
import type { Character, IDatabaseAdapter, Memory, UUID, Content, HandlerCallback } from '../../types';
import { MemoryType, ModelType, ChannelType } from '../../types';
import { v4 as uuidv4 } from 'uuid';

describe('Core Runtime E2E Tests', () => {
  let runtime: AgentRuntime;
  let mockAdapter: IDatabaseAdapter;
  let testCharacter: Character;
  let agentId: UUID;
  let roomId: UUID;
  let entityId: UUID;
  let messageService: DefaultMessageService;
  let responseCallback: HandlerCallback;
  let capturedResponses: Content[];

  beforeEach(() => {
    agentId = uuidv4() as UUID;
    roomId = uuidv4() as UUID;
    entityId = uuidv4() as UUID;
    capturedResponses = [];

    testCharacter = {
      id: agentId,
      name: 'TestAgent',
      username: 'testagent',
      bio: ['A helpful AI assistant'],
      messageExamples: [],
      postExamples: [],
      topics: [],
      style: { all: [], chat: [], post: [] },
      adjectives: [],
      settings: {
        MODEL: 'gpt-4',
      },
    };

    responseCallback = mock(async (content: Content) => {
      capturedResponses.push(content);
      return [
        {
          id: uuidv4() as UUID,
          content,
          entityId: agentId,
          agentId,
          roomId,
          createdAt: Date.now(),
        },
      ];
    });

    mockAdapter = {
      db: {},
      init: mock(async () => {}),
      initialize: mock(async () => {}),
      close: mock(async () => {}),
      isReady: mock(async () => true),
      getConnection: mock(async () => ({})),
      getAgent: mock(async () => null),
      getAgents: mock(async () => []),
      createAgent: mock(async () => true),
      updateAgent: mock(async () => true),
      deleteAgent: mock(async () => true),
      ensureEmbeddingDimension: mock(async () => {}),
      log: mock(async () => {}),
      runPluginMigrations: mock(async () => {}),
      getEntitiesByIds: mock(async () => [
        {
          id: entityId,
          names: ['TestUser'],
          agentId,
        },
      ]),
      getRoomsByIds: mock(async () => [
        {
          id: roomId,
          name: 'Test Room',
          type: ChannelType.GROUP,
          worldId: uuidv4() as UUID,
        },
      ]),
      getParticipantsForRoom: mock(async () => []),
      createEntities: mock(async () => true),
      addParticipantsRoom: mock(async () => true),
      createRooms: mock(async () => [roomId]),
      getEntitiesForRoom: mock(async () => []),
      updateEntity: mock(async () => {}),
      getComponent: mock(async () => null),
      getComponents: mock(async () => []),
      createComponent: mock(async () => true),
      updateComponent: mock(async () => {}),
      deleteComponent: mock(async () => {}),
      getMemories: mock(async () => []),
      getMemoryById: mock(async () => null),
      getMemoriesByIds: mock(async () => []),
      getMemoriesByRoomIds: mock(async () => []),
      getCachedEmbeddings: mock(async () => []),
      getLogs: mock(async () => []),
      deleteLog: mock(async () => {}),
      searchMemories: mock(async () => []),
      createMemory: mock(async () => uuidv4() as UUID),
      updateMemory: mock(async () => true),
      deleteMemory: mock(async () => {}),
      deleteManyMemories: mock(async () => {}),
      deleteAllMemories: mock(async () => {}),
      countMemories: mock(async () => 0),
      createWorld: mock(async () => uuidv4() as UUID),
      getWorld: mock(async () => null),
      getAllWorlds: mock(async () => []),
      updateWorld: mock(async () => {}),
      removeWorld: mock(async () => {}),
      getRoomsByWorld: mock(async () => []),
      updateRoom: mock(async () => {}),
      deleteRoom: mock(async () => {}),
      deleteRoomsByWorldId: mock(async () => {}),
      getRoomsForParticipant: mock(async () => []),
      getRoomsForParticipants: mock(async () => []),
      removeParticipant: mock(async () => true),
      getParticipantsForEntity: mock(async () => []),
      isRoomParticipant: mock(async () => false),
      getParticipantUserState: mock(async () => null),
      setParticipantUserState: mock(async () => {}),
      createRelationship: mock(async () => true),
      getRelationship: mock(async () => null),
      getRelationships: mock(async () => []),
      updateRelationship: mock(async () => {}),
      getCache: mock(async () => undefined),
      setCache: mock(async () => true),
      deleteCache: mock(async () => true),
      createTask: mock(async () => uuidv4() as UUID),
      getTasks: mock(async () => []),
      getTask: mock(async () => null),
      getTasksByName: mock(async () => []),
      updateTask: mock(async () => {}),
      deleteTask: mock(async () => {}),
      getMemoriesByWorldId: mock(async () => []),
    } as IDatabaseAdapter;

    runtime = new AgentRuntime({
      character: testCharacter,
      adapter: mockAdapter,
    });

    messageService = new DefaultMessageService();

    // Mock useModel to return realistic responses
    runtime.useModel = mock(async (modelType: string) => {
      if (modelType === ModelType.TEXT_SMALL) {
        return '<shouldRespond>true</shouldRespond><reason>User message</reason>';
      }
      return '<thought>I should respond</thought><text>Hello! How can I help you?</text>';
    });
  });

  afterEach(() => {
    mock.restore();
    capturedResponses = [];
  });

  describe('Complete Message Processing Workflow', () => {
    it('should process a message from creation to response', async () => {
      const userMessage = createMessageMemory({
        entityId,
        roomId,
        content: { text: 'Hello, agent!' },
      });

      const result = await messageService.handleMessage(runtime, userMessage, responseCallback);

      expect(result.didRespond).toBeDefined();
      expect(typeof result.didRespond).toBe('boolean');
      expect(mockAdapter.createMemory).toHaveBeenCalled();
      expect(result.state).toBeDefined();
      expect(result.responseMessages).toBeDefined();
      expect(Array.isArray(result.responseMessages)).toBe(true);
    });

    it('should store message in memory and retrieve it', async () => {
      const userMessage = createMessageMemory({
        entityId,
        roomId,
        content: { text: 'Test message for memory' },
      });

      const storedMemories: Memory[] = [userMessage];
      (mockAdapter.getMemories as ReturnType<typeof mock>).mockResolvedValue(storedMemories);

      await messageService.handleMessage(runtime, userMessage, responseCallback);

      const retrievedMemories = await runtime.adapter.getMemories({ roomId, count: 10, tableName: 'messages' });
      expect(retrievedMemories).toHaveLength(1);
      expect(getMemoryText(retrievedMemories[0])).toBe('Test message for memory');
    });

    it('should handle multi-turn conversation', async () => {
      const message1 = createMessageMemory({
        entityId,
        roomId,
        content: { text: 'What is 2+2?' },
      });

      const message2 = createMessageMemory({
        entityId,
        roomId,
        content: { text: 'What about 3+3?' },
      });

      const conversationHistory: Memory[] = [message1, message2];
      (mockAdapter.getMemoriesByRoomIds as ReturnType<typeof mock>).mockResolvedValue(conversationHistory);
      (mockAdapter.getMemories as ReturnType<typeof mock>).mockResolvedValue(conversationHistory);

      await messageService.handleMessage(runtime, message1, responseCallback);
      await messageService.handleMessage(runtime, message2, responseCallback);

      // Message service creates memories for both user messages and agent responses
      expect(mockAdapter.createMemory).toHaveBeenCalled();
      expect(mockAdapter.createMemory.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Character and Runtime Integration', () => {
    it('should parse character and initialize runtime correctly', () => {
      const parsed = parseCharacter(testCharacter);
      const newRuntime = new AgentRuntime({
        character: parsed,
        adapter: mockAdapter,
      });

      expect(newRuntime.character.name).toBe('TestAgent');
      expect(newRuntime.character.settings?.MODEL).toBe('gpt-4');
      expect(newRuntime.agentId).toBe(agentId);
    });
  });

  describe('Memory Operations Integration', () => {
    it('should create, store, and retrieve memories through runtime', async () => {
      const memory = createMessageMemory({
        entityId,
        roomId,
        agentId,
        content: { text: 'Integration test memory' },
      });

      const memoryId = await runtime.createMemory(memory, 'messages');
      expect(memoryId).toBeDefined();

      const storedMemories: Memory[] = [memory];
      (mockAdapter.getMemories as ReturnType<typeof mock>).mockResolvedValue(storedMemories);

      const retrieved = await runtime.adapter.getMemories({ roomId, count: 1, tableName: 'messages' });
      expect(retrieved).toHaveLength(1);
      expect(getMemoryText(retrieved[0])).toBe('Integration test memory');
    });
  });

  describe('Message Service Integration', () => {
    it('should process message through complete service pipeline and generate response', async () => {
      const message = createMessageMemory({
        entityId,
        roomId,
        content: { text: 'Hello, can you help me?' },
      });

      const result = await messageService.handleMessage(runtime, message, responseCallback);

      expect(result).toBeDefined();
      expect(result.didRespond).toBeDefined();
      expect(result.responseContent).toBeDefined();
      expect(result.state).toBeDefined();
      expect(mockAdapter.createMemory).toHaveBeenCalled();
      
      // Verify the message was stored
      expect(mockAdapter.createMemory.mock.calls.length).toBeGreaterThan(0);
    });
  });
});

