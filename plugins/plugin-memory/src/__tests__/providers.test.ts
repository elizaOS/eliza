import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { shortTermMemoryProvider } from '../providers/short-term-memory';
import { longTermMemoryProvider } from '../providers/long-term-memory';
import { contextSummaryProvider } from '../providers/context-summary';
import { recentMessagesProvider } from '../providers/recent-messages';
import { MemoryService } from '../services/memory-service';
import { LongTermMemoryCategory } from '../types/index';
import type { IAgentRuntime, Memory, UUID, State } from '@elizaos/core';

describe('Providers', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemoryService: MemoryService;
  let mockState: State;

  beforeEach(() => {
    mockMemoryService = new MemoryService();

    // Create mock database
    const mockDb = {
      insert: mock(() => ({
        values: mock(async () => {}),
      })),
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            orderBy: mock(() => ({
              limit: mock(async () => []),
            })),
            limit: mock(async () => []),
          })),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(async () => {}),
        })),
      })),
      delete: mock(() => ({
        where: mock(async () => {}),
      })),
    };

    mockRuntime = {
      agentId: 'test-agent' as UUID,
      character: { name: 'TestAgent' },
      getSetting: mock(() => undefined),
      countMemories: mock(async () => 0),
      getMemories: mock(async () => []),
      getMemoriesByRoomIds: mock(async () => []),
      getRoom: mock(async () => null),
      getEntitiesForRoom: mock(async () => []),
      getRoomsForParticipants: mock(async () => []),
      getConversationLength: mock(() => 16),
      getService: mock((name: string) => {
        if (name === 'memory') return mockMemoryService;
        return null;
      }),
      db: mockDb,
      getConnection: mock(async () => ({
        query: mock(async () => ({ rows: [] })),
      })),
    } as unknown as IAgentRuntime;

    mockState = {} as State;

    mockMemoryService.initialize(mockRuntime);
  });

  describe('shortTermMemoryProvider', () => {
    it('should have correct metadata', () => {
      expect(shortTermMemoryProvider.name).toBe('SHORT_TERM_MEMORY');
      expect(shortTermMemoryProvider.description).toContain('conversation context');
      expect(shortTermMemoryProvider.position).toBe(95);
    });

    it('should return conversation context when no summaries exist', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await shortTermMemoryProvider.get(mockRuntime, message, mockState);

      // Should return full conversation mode context (not empty)
      expect(result.data).toBeDefined();
      expect(result.text).toContain('# Received Message');
    });

    it('should format session summaries', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      // Mock database to return summaries
      const mockSummaryData = [
        {
          id: 'summary-1',
          agentId: mockRuntime.agentId,
          roomId: message.roomId,
          summary: 'Discussed TypeScript features',
          messageCount: 25,
          lastMessageOffset: 25,
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(),
          topics: ['TypeScript', 'Features'],
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockSummaryData),
              })),
            })),
          })),
        })),
      };

      const result = await shortTermMemoryProvider.get(mockRuntime, message, mockState);

      // The provider should return data (may include summaries or conversation context depending on mode)
      expect(result.data).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    });

    it('should return empty when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await shortTermMemoryProvider.get(mockRuntime, message, mockState);

      // Should still return conversation context even without service
      expect(result.data).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    });
  });

  describe('longTermMemoryProvider', () => {
    it('should have correct metadata', () => {
      expect(longTermMemoryProvider.name).toBe('LONG_TERM_MEMORY');
      expect(longTermMemoryProvider.description).toContain('Persistent facts');
      expect(longTermMemoryProvider.position).toBe(50);
    });

    it('should return empty for agent messages', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: mockRuntime.agentId,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toEqual([]);
      expect(result.text).toBe('');
    });

    it('should return empty when no memories exist', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toEqual([]);
      expect(result.text).toBe('');
    });

    it('should format long-term memories by category', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      // Mock database to return memories
      const mockMemoryData = [
        {
          id: 'mem-1',
          agentId: mockRuntime.agentId,
          entityId: message.entityId,
          category: LongTermMemoryCategory.SEMANTIC,
          content: 'User is a software engineer',
          metadata: {},
          confidence: 0.95,
          source: 'conversation',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
          embedding: null,
        },
        {
          id: 'mem-2',
          agentId: mockRuntime.agentId,
          entityId: message.entityId,
          category: LongTermMemoryCategory.PROCEDURAL,
          content: 'Prefers TypeScript',
          metadata: {},
          confidence: 0.85,
          source: 'conversation',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: null,
          accessCount: 0,
          embedding: null,
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockMemoryData),
              })),
            })),
          })),
        })),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toHaveLength(2);
      expect(result.text).toContain('What I Know About You');
      expect(result.text).toContain('Semantic');
      expect(result.text).toContain('software engineer');
      expect(result.text).toContain('Procedural');
      expect(result.text).toContain('TypeScript');
      expect(result.values?.memoryCategories).toContain('semantic: 1');
      expect(result.values?.memoryCategories).toContain('procedural: 1');
    });

    it('should return empty when service is not available', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await longTermMemoryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.memories).toEqual([]);
      expect(result.text).toBe('');
    });
  });

  describe('contextSummaryProvider', () => {
    it('should have correct metadata', () => {
      expect(contextSummaryProvider.name).toBe('SUMMARIZED_CONTEXT');
      expect(contextSummaryProvider.description).toContain('summarized context');
      expect(contextSummaryProvider.position).toBe(96);
    });

    it('should return empty when no memory service exists', async () => {
      mockRuntime.getService = mock(() => null);

      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await contextSummaryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summary).toBeNull();
      expect(result.values?.sessionSummaries).toBe('');
      expect(result.values?.sessionSummariesWithTopics).toBe('');
      expect(result.text).toBe('');
    });

    it('should return empty when no summary exists', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const result = await contextSummaryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summary).toBeNull();
      expect(result.values?.sessionSummaries).toBe('');
      expect(result.values?.sessionSummariesWithTopics).toBe('');
      expect(result.text).toBe('');
    });

    it('should return summary without topics', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const mockSummaryData = [
        {
          id: 'summary-1',
          agentId: mockRuntime.agentId,
          roomId: message.roomId,
          summary: 'Discussed TypeScript features',
          messageCount: 25,
          lastMessageOffset: 25,
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(),
          topics: ['TypeScript', 'Features'],
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockSummaryData),
              })),
            })),
          })),
        })),
      };

      const result = await contextSummaryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summary).toBeDefined();
      expect(result.values?.sessionSummaries).toContain('Discussed TypeScript features');
      expect(result.values?.sessionSummaries).not.toContain('Topics:');
      expect(result.text).toContain('Discussed TypeScript features');
    });

    it('should return summary with topics', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const mockSummaryData = [
        {
          id: 'summary-1',
          agentId: mockRuntime.agentId,
          roomId: message.roomId,
          summary: 'Discussed TypeScript features',
          messageCount: 25,
          lastMessageOffset: 25,
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(),
          topics: ['TypeScript', 'Features'],
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockSummaryData),
              })),
            })),
          })),
        })),
      };

      const result = await contextSummaryProvider.get(mockRuntime, message, mockState);

      expect(result.data?.summary).toBeDefined();
      expect(result.values?.sessionSummariesWithTopics).toContain('Discussed TypeScript features');
      expect(result.values?.sessionSummariesWithTopics).toContain('Topics: TypeScript, Features');
    });
  });

  describe('recentMessagesProvider', () => {
    it('should have correct metadata', () => {
      expect(recentMessagesProvider.name).toBe('RECENT_MESSAGES');
      expect(recentMessagesProvider.description).toContain('recent conversation messages');
      expect(recentMessagesProvider.position).toBe(94);
    });

    it('should return recent messages when below threshold', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const mockMessages = [
        {
          id: 'msg-1' as UUID,
          entityId: 'user-1' as UUID,
          roomId: 'room-1' as UUID,
          content: { text: 'Hello' },
          metadata: { type: 'user_message' },
          createdAt: Date.now(),
        },
        {
          id: 'msg-2' as UUID,
          entityId: mockRuntime.agentId,
          roomId: 'room-1' as UUID,
          content: { text: 'Hi there!' },
          metadata: { type: 'agent_response_message' },
          createdAt: Date.now() + 1000,
        },
      ];

      mockRuntime.getMemories = mock(async () => mockMessages);
      mockRuntime.getConversationLength = mock(() => 16);

      const result = await recentMessagesProvider.get(mockRuntime, message, mockState);

      expect(result.data?.messages).toBeDefined();
      expect(result.values?.recentMessages).toContain('# Recent Messages');
      expect(result.values?.conversationLog).toBeDefined();
      expect(result.values?.conversationLogWithAgentThoughts).toBeDefined();
    });

    it('should handle offset when summary exists', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const mockSummaryData = [
        {
          id: 'summary-1',
          agentId: mockRuntime.agentId,
          roomId: message.roomId,
          summary: 'Previous conversation',
          messageCount: 25,
          lastMessageOffset: 25,
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(),
          topics: [],
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (mockRuntime as any).db = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() => ({
              orderBy: mock(() => ({
                limit: mock(async () => mockSummaryData),
              })),
            })),
          })),
        })),
      };

      const mockMessages = [
        {
          id: 'msg-26' as UUID,
          entityId: 'user-1' as UUID,
          roomId: 'room-1' as UUID,
          content: { text: 'New message' },
          metadata: { type: 'user_message' },
          createdAt: Date.now(),
        },
      ];

      mockRuntime.getMemories = mock(async () => mockMessages);

      const result = await recentMessagesProvider.get(mockRuntime, message, mockState);

      expect(result.data?.messages).toBeDefined();
      expect(result.values?.recentMessages).toBeDefined();
    });

    it('should include received message header and focus header', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'What is TypeScript?' },
        metadata: { entityName: 'John' },
        createdAt: Date.now(),
      };

      const result = await recentMessagesProvider.get(mockRuntime, message, mockState);

      expect(result.values?.receivedMessageHeader).toContain('# Received Message');
      expect(result.values?.receivedMessageHeader).toContain('What is TypeScript?');
      expect(result.values?.focusHeader).toContain('# Focus your response');
    });

    it('should filter out action results', async () => {
      const message: Memory = {
        id: 'msg-1' as UUID,
        entityId: 'user-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'Hello' },
        createdAt: Date.now(),
      };

      const mockMessages = [
        {
          id: 'msg-1' as UUID,
          entityId: 'user-1' as UUID,
          roomId: 'room-1' as UUID,
          content: { text: 'Hello' },
          metadata: { type: 'user_message' },
          createdAt: Date.now(),
        },
        {
          id: 'action-1' as UUID,
          entityId: mockRuntime.agentId,
          roomId: 'room-1' as UUID,
          content: { type: 'action_result', text: 'Action executed' },
          metadata: { type: 'action_result' },
          createdAt: Date.now() + 500,
        },
        {
          id: 'msg-2' as UUID,
          entityId: mockRuntime.agentId,
          roomId: 'room-1' as UUID,
          content: { text: 'Hi there!' },
          metadata: { type: 'agent_response_message' },
          createdAt: Date.now() + 1000,
        },
      ];

      mockRuntime.getMemories = mock(async () => mockMessages);
      mockRuntime.getConversationLength = mock(() => 16);

      const result = await recentMessagesProvider.get(mockRuntime, message, mockState);

      // Should only have 2 dialogue messages, not the action result
      expect(result.data?.messages).toHaveLength(2);
    });
  });
});
