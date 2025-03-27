import { Content } from '@elizaos/core';
import { CastParamType } from '@neynar/nodejs-sdk/build/api/models/cast-param-type';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FarcasterClient } from '../src/client';
import * as utils from '../src/common/utils';

// Create mock for dependencies
vi.mock('@elizaos/core', () => {
  return {
    elizaLogger: {
      error: vi.fn(),
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    },
    Content: class {},
  };
});

// Spy on utils.splitPostContent
vi.spyOn(utils, 'splitPostContent');

// Create a mock cast response
const mockCast = {
  hash: 'test-cast-hash',
  author: {
    fid: 123,
  },
  text: 'Test cast',
  timestamp: Date.now().toString(),
  reactions: {
    likes: [],
    recasts: [],
  },
  replies: {
    count: 0,
  },
  threads: {
    count: 0,
  },
};

// Create a mock profile response
const mockProfile = {
  fid: 123,
  username: 'test-user',
  display_name: 'Test User',
  pfp_url: 'https://example.com/avatar.jpg',
  profile: {
    bio: {
      text: 'Test bio',
    },
  },
};

// Create mock for Neynar client
const mockNeynarClient = {
  publishCast: vi.fn().mockResolvedValue({
    success: true,
    cast: mockCast,
  }),
  lookupCastByHashOrWarpcastUrl: vi.fn().mockResolvedValue({
    cast: mockCast,
  }),
  fetchAllNotifications: vi.fn().mockResolvedValue({
    notifications: [
      {
        cast: mockCast,
      },
    ],
  }),
  fetchBulkUsers: vi.fn().mockResolvedValue({
    users: [mockProfile],
  }),
  fetchCastsForUser: vi.fn().mockResolvedValue({
    casts: [mockCast],
    next: {
      cursor: 'next-cursor',
    },
  }),
};

describe('FarcasterClient Cache Functionality', () => {
  let client: FarcasterClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Initialize a fresh client for each test
    client = new FarcasterClient({
      neynar: mockNeynarClient as any,
      signerUuid: 'test-signer-uuid',
    });
  });

  afterEach(() => {
    // Clear cache after each test
    client.clearCache();
  });

  describe('getCast with cache', () => {
    it('should fetch a cast from API when not in cache', async () => {
      const castHash = 'test-cast-hash';

      const cast = await client.getCast(castHash);

      // Should call the API
      expect(mockNeynarClient.lookupCastByHashOrWarpcastUrl).toHaveBeenCalledWith({
        identifier: castHash,
        type: CastParamType.Hash,
      });

      // Should return the cast
      expect(cast).toEqual(mockCast);
    });

    it('should return cached cast when available', async () => {
      const castHash = 'test-cast-hash';

      // First call should hit the API
      await client.getCast(castHash);

      // Reset the mock to verify it's not called again
      mockNeynarClient.lookupCastByHashOrWarpcastUrl.mockClear();

      // Second call should use cache
      const cachedCast = await client.getCast(castHash);

      // API should not be called
      expect(mockNeynarClient.lookupCastByHashOrWarpcastUrl).not.toHaveBeenCalled();

      // Should return the same cast
      expect(cachedCast).toEqual(mockCast);
    });
  });

  describe('getProfile with cache', () => {
    it('should fetch a profile from API when not in cache', async () => {
      const fid = 123;

      const profile = await client.getProfile(fid);

      // Should call the API
      expect(mockNeynarClient.fetchBulkUsers).toHaveBeenCalledWith({
        fids: [fid],
      });

      // Should return profile with correct data
      expect(profile.fid).toBe(fid);
      expect(profile.username).toBe('test-user');
      expect(profile.name).toBe('Test User');
      expect(profile.bio).toBe('Test bio');
      expect(profile.pfp).toBe('https://example.com/avatar.jpg');
    });

    it('should return cached profile when available', async () => {
      const fid = 123;

      // First call should hit the API
      await client.getProfile(fid);

      // Reset the mock to verify it's not called again
      mockNeynarClient.fetchBulkUsers.mockClear();

      // Second call should use cache
      const cachedProfile = await client.getProfile(fid);

      // API should not be called
      expect(mockNeynarClient.fetchBulkUsers).not.toHaveBeenCalled();

      // Should return the same profile
      expect(cachedProfile.fid).toBe(fid);
      expect(cachedProfile.username).toBe('test-user');
    });

    it('should throw error when profile fetch fails', async () => {
      const fid = 456;

      // Mock the API to return empty users array
      mockNeynarClient.fetchBulkUsers.mockResolvedValueOnce({
        users: [],
      });

      await expect(client.getProfile(fid)).rejects.toThrow('Profile fetch failed');
    });
  });

  describe('clearCache', () => {
    it('should clear both cast and profile caches', async () => {
      const castHash = 'test-cast-hash';
      const fid = 123;

      // Populate the caches
      await client.getCast(castHash);
      await client.getProfile(fid);

      // Clear the API call mocks
      mockNeynarClient.lookupCastByHashOrWarpcastUrl.mockClear();
      mockNeynarClient.fetchBulkUsers.mockClear();

      // Clear the caches
      client.clearCache();

      // Fetch again - should call APIs again
      await client.getCast(castHash);
      await client.getProfile(fid);

      // Both APIs should be called again
      expect(mockNeynarClient.lookupCastByHashOrWarpcastUrl).toHaveBeenCalledTimes(1);
      expect(mockNeynarClient.fetchBulkUsers).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTimeline', () => {
    it('should fetch timeline and populate cast cache', async () => {
      const request = { fid: 123, pageSize: 10 };

      // Get timeline
      const result = await client.getTimeline(request);

      // API should be called
      expect(mockNeynarClient.fetchCastsForUser).toHaveBeenCalledWith({
        fid: request.fid,
        limit: request.pageSize,
      });

      // Should return timeline with cursor
      expect(result.timeline.length).toBe(1);
      expect(result.cursor).toBe('next-cursor');

      // Should cache casts
      mockNeynarClient.lookupCastByHashOrWarpcastUrl.mockClear();

      // Fetch the cast that should now be in cache
      await client.getCast(mockCast.hash);

      // API should not be called for the cast
      expect(mockNeynarClient.lookupCastByHashOrWarpcastUrl).not.toHaveBeenCalled();
    });
  });

  describe('sendCast', () => {
    it('should use splitPostContent to split long content', async () => {
      // Fake a split response from the splitPostContent function
      const splitPosts = ['Part 1', 'Part 2', 'Part 3'];
      vi.mocked(utils.splitPostContent).mockReturnValueOnce(splitPosts);

      // Create mock content
      const content: Content = {
        text: 'A'.repeat(1000), // Long content
      };

      // Each part will generate a unique cast hash
      mockNeynarClient.publishCast.mockImplementation((params) => {
        const idx = mockNeynarClient.publishCast.mock.calls.length;
        return Promise.resolve({
          success: true,
          cast: { ...mockCast, hash: `test-cast-hash-${idx}` },
        });
      });

      const result = await client.sendCast({ content });

      // Should call splitPostContent with the content text
      expect(utils.splitPostContent).toHaveBeenCalledWith(content.text);

      // Should call publishCast for each split part
      expect(mockNeynarClient.publishCast).toHaveBeenCalledTimes(splitPosts.length);

      // Check that each part was sent
      splitPosts.forEach((part, i) => {
        expect(mockNeynarClient.publishCast).toHaveBeenNthCalledWith(
          i + 1,
          expect.objectContaining({
            text: part,
          })
        );
      });

      // Should return an array of results
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(splitPosts.length);
    });

    it('should return empty array for empty content', async () => {
      const content: Content = { text: '' };

      const result = await client.sendCast({ content });

      // Should not call publishCast
      expect(mockNeynarClient.publishCast).not.toHaveBeenCalled();

      // Should not call splitPostContent
      expect(utils.splitPostContent).not.toHaveBeenCalled();

      // Should return empty array
      expect(result).toEqual([]);
    });
  });
});
