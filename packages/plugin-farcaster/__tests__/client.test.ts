import { IAgentRuntime } from '@elizaos/core';
import { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { CastParamType } from '@neynar/nodejs-sdk/build/api/models/cast-param-type';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FarcasterClient } from '../src/client';

// Mock dependencies
vi.mock('@neynar/nodejs-sdk', () => ({
  NeynarAPIClient: vi.fn().mockImplementation(() => ({
    fetchProfile: vi.fn().mockResolvedValue({
      fid: 123,
      display_name: 'Test User',
      username: 'test.farcaster',
      pfp_url: 'https://example.com/pic.jpg',
      profile: {
        bio: {
          text: 'Test bio',
        },
      },
    }),
    fetchBulkUsers: vi.fn(),
    fetchUserCasts: vi.fn().mockResolvedValue([]),
    fetchFeed: vi.fn().mockResolvedValue([]),
    fetchOwnCasts: vi.fn().mockResolvedValue([]),
    fetchCastsForUser: vi.fn().mockResolvedValue({
      casts: [
        {
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
      ],
    }),
    lookupCastByHashOrWarpcastUrl: vi.fn(),
    fetchAllNotifications: vi.fn(),
    publishCast: vi.fn(),
  })),
  CastParamType: {
    Hash: 'hash',
  },
  isApiErrorResponse: vi.fn().mockReturnValue(false),
}));

vi.mock('@elizaos/core', () => ({
  Content: vi.fn().mockImplementation(() => ({ text: '' })),
  elizaLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock the common utils module
vi.mock('../src/common/utils', () => ({
  splitPostContent: vi
    .fn()
    .mockImplementation((text) =>
      text.length > 320 ? [text.slice(0, 320), text.slice(320)] : [text]
    ),
  neynarCastToCast: vi.fn().mockImplementation((cast) => ({
    hash: cast.hash,
    text: cast.text,
    author: cast.author,
    timestamp: cast.timestamp,
  })),
}));

describe('FarcasterClient', () => {
  let client: FarcasterClient;
  const mockRuntime: IAgentRuntime = {
    agentId: 'test-agent',
    character: 'test-character',
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: {},
    events: {},
    init: vi.fn(),
    close: vi.fn(),
    getAgent: vi.fn(),
    getMemory: vi.fn(),
    getMemories: vi.fn(),
    getKnowledge: vi.fn(),
    addKnowledge: vi.fn(),
    getService: vi.fn(),
    registerPlugin: vi.fn(),
    initialize: vi.fn(),
    registerService: vi.fn(),
    registerAction: vi.fn(),
    registerEvaluator: vi.fn(),
    registerEvent: vi.fn(),
    emitEvent: vi.fn(),
    useModel: vi.fn(),
    registerModel: vi.fn(),
    getModel: vi.fn(),
    registerTaskWorker: vi.fn(),
    getTaskWorker: vi.fn(),
    stop: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FarcasterClient({
      runtime: mockRuntime,
      url: 'https://api.example.com',
      ssl: true,
      neynar: new NeynarAPIClient({ apiKey: 'test-key' }),
      signerUuid: 'test-signer',
      cache: new Map(),
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
    client.clearCache();
  });

  describe('sendCast', () => {
    it('should send a cast successfully', async () => {
      const content = { text: 'Hello world' };
      const mockCast = { hash: 'test-hash', text: 'Hello world' };

      client.neynar.publishCast.mockResolvedValue({
        success: true,
        cast: { hash: 'test-hash' },
      });

      client.neynar.lookupCastByHashOrWarpcastUrl.mockResolvedValue({
        cast: mockCast,
      });

      const result = await client.sendCast({ content });

      expect(client.neynar.publishCast).toHaveBeenCalledWith({
        signerUuid: 'test-signer',
        text: 'Hello world',
        parent: undefined,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockCast);
    });

    it('should handle empty content', async () => {
      const content = { text: '' };
      const result = await client.sendCast({ content });

      expect(client.neynar.publishCast).not.toHaveBeenCalled();
      expect(result).toHaveLength(0);
    });
  });

  describe('getCast', () => {
    it('should fetch a cast by hash', async () => {
      const mockCast = { hash: 'test-hash', text: 'Test content' };

      client.neynar.lookupCastByHashOrWarpcastUrl.mockResolvedValue({
        cast: mockCast,
      });

      const result = await client.getCast('test-hash');

      expect(client.neynar.lookupCastByHashOrWarpcastUrl).toHaveBeenCalledWith({
        identifier: 'test-hash',
        type: CastParamType.Hash,
      });

      expect(result).toEqual(mockCast);
    });
  });

  describe('getMentions', () => {
    it('should fetch mentions for a user', async () => {
      const mockCast = { hash: 'test-hash', text: 'Test mention' };

      client.neynar.fetchAllNotifications.mockResolvedValue({
        notifications: [{ cast: mockCast }, { cast: { ...mockCast, hash: 'other-hash' } }],
      });

      const result = await client.getMentions({ fid: 123, pageSize: 10 });

      expect(client.neynar.fetchAllNotifications).toHaveBeenCalledWith({
        fid: 123,
        type: ['mentions', 'replies'],
        limit: 10,
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockCast);
    });
  });

  describe('getProfile', () => {
    it('should fetch a user profile by fid', async () => {
      const mockUser = {
        fid: 123,
        username: 'testuser',
        display_name: 'Test User',
        pfp_url: 'https://example.com/avatar.jpg',
        profile: {
          bio: {
            text: 'Test bio',
          },
        },
      };

      client.neynar.fetchBulkUsers.mockResolvedValue({
        users: [mockUser],
      });

      const result = await client.getProfile(123);

      expect(client.neynar.fetchBulkUsers).toHaveBeenCalledWith({
        fids: [123],
      });

      expect(result).toEqual({
        fid: 123,
        name: 'Test User',
        username: 'testuser',
        bio: 'Test bio',
        pfp: 'https://example.com/avatar.jpg',
      });
    });
  });

  describe('getTimeline', () => {
    it('should fetch timeline for a user', async () => {
      const mockCast1 = {
        hash: 'hash1',
        text: 'Test cast 1',
        author: { fid: 123 },
        timestamp: '2023-01-01T00:00:00Z',
      };
      const mockCast2 = {
        hash: 'hash2',
        text: 'Test cast 2',
        author: { fid: 456 },
        timestamp: '2023-01-02T00:00:00Z',
      };

      client.neynar.fetchCastsForUser.mockResolvedValue({
        casts: [mockCast1, mockCast2],
        next: { cursor: 'next-cursor' },
      });

      const result = await client.getTimeline({ fid: 123, pageSize: 10 });

      expect(client.neynar.fetchCastsForUser).toHaveBeenCalledWith({
        fid: 123,
        limit: 10,
      });

      expect(result.timeline).toHaveLength(2);
      expect(result.cursor).toBe('next-cursor');
    });
  });

  describe('clearCache', () => {
    it('should clear caches', async () => {
      const mockCast = { hash: 'test-hash', text: 'Test content' };
      const mockUser = {
        fid: 123,
        username: 'testuser',
        display_name: 'Test User',
        pfp_url: 'https://example.com/avatar.jpg',
        profile: {
          bio: {
            text: 'Test bio',
          },
        },
      };

      // Setup caches
      client.neynar.lookupCastByHashOrWarpcastUrl.mockResolvedValue({
        cast: mockCast,
      });

      client.neynar.fetchBulkUsers.mockResolvedValue({
        users: [mockUser],
      });

      // Fill cache
      await client.getCast('test-hash');
      await client.getProfile(123);

      expect(client.neynar.lookupCastByHashOrWarpcastUrl).toHaveBeenCalledTimes(1);
      expect(client.neynar.fetchBulkUsers).toHaveBeenCalledTimes(1);

      // Clear cache
      client.clearCache();

      // Call again
      await client.getCast('test-hash');
      await client.getProfile(123);

      // Should be called again
      expect(client.neynar.lookupCastByHashOrWarpcastUrl).toHaveBeenCalledTimes(2);
      expect(client.neynar.fetchBulkUsers).toHaveBeenCalledTimes(2);
    });
  });
});
