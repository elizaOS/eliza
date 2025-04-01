import { IAgentRuntime, UUID } from '@elizaos/core';
import { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FarcasterClient } from '../src/client';
import { createTestCast } from './test-utils';

// Mock dependencies
vi.mock('@neynar/nodejs-sdk', () => ({
  NeynarAPIClient: vi.fn().mockImplementation(() => ({
    publishCast: vi.fn().mockImplementation(({ text }) => ({
      success: true,
      cast: {
        hash: 'cast-1',
        author: {
          fid: 123,
          username: 'test.farcaster',
          display_name: 'Test User',
          pfp_url: 'https://example.com/pic.jpg',
          profile: {
            bio: {
              text: 'Test bio',
            },
          },
        },
        text: text,
        timestamp: '2025-01-20T20:00:00Z',
      },
    })),
    lookupCastByHashOrWarpcastUrl: vi.fn().mockResolvedValue({
      cast: {
        hash: 'cast-1',
        author: {
          fid: 123,
          username: 'test.farcaster',
          display_name: 'Test User',
          pfp_url: 'https://example.com/pic.jpg',
          profile: {
            bio: {
              text: 'Test bio',
            },
          },
        },
        text: 'Test cast',
        timestamp: '2025-01-20T20:00:00Z',
      },
    }),
  })),
  CastParamType: {
    Hash: 'hash',
  },
  isApiErrorResponse: vi.fn().mockReturnValue(false),
}));

describe('Cast Functions', () => {
  let client: FarcasterClient;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = {
      agentId: 'test-agent-id' as UUID,
      character: {
        name: 'Test Character',
        bio: 'A test character for Farcaster integration',
      },
      providers: [],
      actions: [],
      evaluators: [],
      plugins: [],
      services: new Map(),
      events: new Map(),
      routes: [],
      fetch: vi.fn(),
      registerPlugin: vi.fn(),
      initialize: vi.fn(),
      getKnowledge: vi.fn(),
      addKnowledge: vi.fn(),
      getService: vi.fn(),
      getAllServices: vi.fn(),
      registerService: vi.fn(),
      registerDatabaseAdapter: vi.fn(),
      setSetting: vi.fn(),
      getSetting: vi.fn(),
      getConversationLength: vi.fn(),
      processActions: vi.fn(),
      evaluate: vi.fn(),
      registerProvider: vi.fn(),
      registerAction: vi.fn(),
      registerEvaluator: vi.fn(),
      ensureConnection: vi.fn(),
      ensureParticipantInRoom: vi.fn(),
      ensureWorldExists: vi.fn(),
      ensureRoomExists: vi.fn(),
      composeState: vi.fn(),
      init: vi.fn(),
      close: vi.fn(),
      getAgent: vi.fn(),
      getAgents: vi.fn(),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      deleteAgent: vi.fn(),
      ensureAgentExists: vi.fn(),
      ensureEmbeddingDimension: vi.fn(),
      getEntityById: vi.fn(),
      getEntitiesForRoom: vi.fn(),
      createEntity: vi.fn(),
      updateEntity: vi.fn(),
      getComponent: vi.fn(),
      getComponents: vi.fn(),
      createComponent: vi.fn(),
      updateComponent: vi.fn(),
      deleteComponent: vi.fn(),
      getMemories: vi.fn(),
      getMemoryById: vi.fn(),
      getMemoriesByIds: vi.fn(),
      getMemoriesByRoomIds: vi.fn(),
      getCachedEmbeddings: vi.fn(),
      log: vi.fn(),
      db: {},
      createMemory: vi.fn(),
      createWorld: vi.fn(),
      getWorld: vi.fn(),
      updateWorld: vi.fn(),
      createTask: vi.fn(),
      getTask: vi.fn(),
      useModel: vi.fn(),
      registerModel: vi.fn(),
      getModel: vi.fn(),
      registerEvent: vi.fn(),
      getEvent: vi.fn(),
      emitEvent: vi.fn(),
      registerTaskWorker: vi.fn(),
      getTaskWorker: vi.fn(),
      stop: vi.fn(),
      addEmbeddingToMemory: vi.fn(),
      getLogs: vi.fn(),
      deleteLog: vi.fn(),
      searchMemories: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
      deleteAllMemories: vi.fn(),
      countMemories: vi.fn(),
      getAllWorlds: vi.fn(),
      createRoom: vi.fn(),
      deleteRoom: vi.fn(),
      updateRoom: vi.fn(),
      getRoomsForParticipant: vi.fn(),
      getRoomsForParticipants: vi.fn(),
      getRooms: vi.fn(),
      addParticipant: vi.fn(),
      removeParticipant: vi.fn(),
      getParticipantsForEntity: vi.fn(),
      getParticipantsForRoom: vi.fn(),
      getParticipantUserState: vi.fn(),
      setParticipantUserState: vi.fn(),
      getRoom: vi.fn(),
      createRelationship: vi.fn(),
      updateRelationship: vi.fn(),
      getRelationship: vi.fn(),
      getRelationships: vi.fn(),
      getCache: vi.fn(),
      setCache: vi.fn(),
      deleteCache: vi.fn(),
      getTasks: vi.fn(),
      getTasksByName: vi.fn(),
      updateTask: vi.fn(),
      deleteTask: vi.fn(),
    };

    client = new FarcasterClient({
      runtime: mockRuntime,
      url: 'https://api.example.com',
      ssl: true,
      neynar: new NeynarAPIClient({ apiKey: 'test-key' }),
      signerUuid: 'test-signer',
      farcasterConfig: {
        FARCASTER_DRY_RUN: false,
        FARCASTER_FID: 123,
        MAX_CAST_LENGTH: 320,
        FARCASTER_POLL_INTERVAL: 1000,
        ENABLE_POST: true,
        POST_INTERVAL_MIN: 1000,
        POST_INTERVAL_MAX: 5000,
        ENABLE_ACTION_PROCESSING: true,
        ACTION_INTERVAL: 1000,
        POST_IMMEDIATELY: true,
        MAX_ACTIONS_PROCESSING: 10,
        FARCASTER_NEYNAR_SIGNER_UUID: 'test-signer',
        FARCASTER_NEYNAR_API_KEY: 'test-key',
        FARCASTER_HUB_URL: 'https://api.example.com',
      },
    });
  });

  describe('createTestCast', () => {
    it('should create a cast successfully', async () => {
      const content = 'Test cast content';
      const result = await createTestCast(client, content);

      expect(result).toBeDefined();
      expect(result.cast.text).toBe(content);
      expect(client['neynar'].publishCast).toHaveBeenCalledWith({
        text: content,
        signerUuid: 'test-signer',
      });
    });

    it('should handle cast creation errors', async () => {
      const content = 'Test cast content';
      vi.mocked(client['neynar'].publishCast).mockRejectedValueOnce(
        new Error('Cast creation failed')
      );
      await expect(createTestCast(client, content)).rejects.toThrow('Cast creation failed');
    });

    it('should handle empty content', async () => {
      const content = '';
      await expect(createTestCast(client, content)).rejects.toThrow('Cast content cannot be empty');
    });

    it('should handle very long content', async () => {
      const content = 'a'.repeat(321); // Farcaster limit is 320 characters
      await expect(createTestCast(client, content)).rejects.toThrow('Cast content too long');
    });
  });
});
