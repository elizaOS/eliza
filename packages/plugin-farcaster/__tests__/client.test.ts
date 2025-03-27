import { IAgentRuntime } from '@autonomous-agents/core';
import { NeynarAPIClient } from '@neynar/nodejs-sdk';
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
  })),
  CastParamType: {
    Hash: 'hash',
  },
  isApiErrorResponse: vi.fn().mockReturnValue(false),
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

  describe('getProfile', () => {
    it('should fetch profile successfully', async () => {
      const client = new FarcasterClient({
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
      vi.spyOn(client.neynar, 'fetchBulkUsers').mockResolvedValue({
        users: [
          {
            fid: 123,
            username: 'test.farcaster',
            display_name: 'Test User',
            pfp_url: 'https://example.com/pfp.jpg',
            custody_address: '0x123',
            profile: {
              bio: {
                text: 'Test bio',
              },
            },
            follower_count: 100,
            following_count: 50,
            verifications: ['0x123'],
            verified_addresses: {
              eth_addresses: ['0x123'],
              sol_addresses: [],
            },
          },
        ],
      });
      const profile = await client.getProfile(123);
      expect(profile).toBeDefined();
      expect(profile.fid).toBe(123);
      expect(profile.username).toBe('test.farcaster');
      expect(profile.name).toBe('Test User');
      expect(profile.bio).toBe('Test bio');
    });

    it('should handle profile fetch errors', async () => {
      const mockNeynar = {
        fetchBulkUsers: vi.fn().mockResolvedValueOnce({ users: [] }),
        fetchProfile: vi.fn(),
        fetchUserCasts: vi.fn(),
        fetchFeed: vi.fn(),
        fetchOwnCasts: vi.fn(),
        fetchCastsForUser: vi.fn(),
      };
      const client = new FarcasterClient({
        runtime: mockRuntime,
        url: 'https://api.example.com',
        ssl: true,
        neynar: mockNeynar as unknown as NeynarAPIClient,
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
      await expect(client.getProfile(123)).rejects.toThrow('Profile fetch failed');
    });
  });

  describe('getTimeline', () => {
    it('should fetch timeline successfully', async () => {
      const result = await client.getTimeline({ fid: 123, pageSize: 10 });
      expect(result.timeline).toHaveLength(1);
      expect(result.timeline[0].hash).toBe('cast-1');
      expect(result.timeline[0].authorFid).toBe(123);
      expect(result.timeline[0].text).toBe('Test cast');
    });

    it('should handle timeline fetch errors', async () => {
      vi.mocked(client.neynar.fetchCastsForUser).mockRejectedValueOnce(
        new Error('Timeline fetch failed')
      );
      await expect(client.getTimeline({ fid: 123, pageSize: 10 })).rejects.toThrow(
        'Timeline fetch failed'
      );
    });
  });
});
