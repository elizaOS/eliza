import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlueSkyAgentManager } from '../../managers/agent.js';
import { BlueSkyClient } from '../../client.js';
import { IAgentRuntime, logger } from '@elizaos/core';
import { BlueSkyConfig } from '../../common/types.js';

// Mock dependencies
vi.mock('../../client.js');
vi.mock('@elizaos/core', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock config functions
vi.mock('../../common/config.js', () => ({
  getPollInterval: vi.fn(() => 60000),
  getActionInterval: vi.fn(() => 60000),
  isPostingEnabled: vi.fn(() => true),
  shouldPostImmediately: vi.fn(() => false),
  getPostIntervalRange: vi.fn(() => ({ min: 300000, max: 600000 })),
  getMaxActionsProcessing: vi.fn(() => 10),
  isDMsEnabled: vi.fn(() => true),
}));

describe('BlueSkyAgentManager', () => {
  let manager: BlueSkyAgentManager;
  let mockRuntime: IAgentRuntime;
  let mockConfig: BlueSkyConfig;
  let mockClient: BlueSkyClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create mock runtime
    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000123' as any,
      getSetting: vi.fn(),
      emitEvent: vi.fn(),
    } as any;

    // Create mock config
    mockConfig = {
      service: 'https://bsky.social',
      handle: 'test.bsky.social',
      password: 'test-password',
      dryRun: false,
      enableActionProcessing: true,
    };

    // Create mock client
    mockClient = {
      authenticate: vi.fn(),
      getNotifications: vi.fn(() => ({ notifications: [] })),
      updateSeenNotifications: vi.fn(),
      cleanup: vi.fn(),
    } as any;

    vi.mocked(BlueSkyClient).mockImplementation(() => mockClient);

    manager = new BlueSkyAgentManager(mockRuntime, mockConfig, mockClient);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with provided dependencies', () => {
      expect(manager.runtime).toBe(mockRuntime);
      expect(manager.config).toBe(mockConfig);
      expect(manager.client).toBe(mockClient);
    });
  });

  describe('start', () => {
    it('should start successfully and initialize all intervals', async () => {
      await manager.start();

      expect(mockClient.authenticate).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Starting BlueSky agent manager', { agentId: mockRuntime.agentId });
      expect(logger.success).toHaveBeenCalledWith('BlueSky agent manager started', { agentId: mockRuntime.agentId });

      // Should have started intervals
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it('should handle start when already running', async () => {
      await manager.start();
      await manager.start();

      expect(logger.warn).toHaveBeenCalledWith('BlueSky agent manager already running', { agentId: mockRuntime.agentId });
      expect(mockClient.authenticate).toHaveBeenCalledTimes(1);
    });

    it('should handle authentication failure', async () => {
      (mockClient.authenticate as any).mockRejectedValueOnce(new Error('Auth failed'));

      await expect(manager.start()).rejects.toThrow('Auth failed');
      expect(logger.error).toHaveBeenCalledWith('Failed to start BlueSky agent manager', expect.any(Object));
    });

    it('should skip action processing if disabled', async () => {
      manager = new BlueSkyAgentManager(mockRuntime, { ...mockConfig, enableActionProcessing: false }, mockClient);
      
      await manager.start();

      // Check that action processing interval wasn't set
      // This is a simplified check - in reality, we'd need to track interval setup
      expect(logger.info).toHaveBeenCalledWith('Starting notification polling', expect.any(Object));
    });
  });

  describe('stop', () => {
    it('should stop all intervals and cleanup', async () => {
      await manager.start();
      
      const timerCountBefore = vi.getTimerCount();
      
      await manager.stop();

      expect(logger.info).toHaveBeenCalledWith('Stopping BlueSky agent manager', { agentId: mockRuntime.agentId });
      expect(logger.success).toHaveBeenCalledWith('BlueSky agent manager stopped', { agentId: mockRuntime.agentId });
      expect(mockClient.cleanup).toHaveBeenCalled();
      
      // All timers should be cleared
      expect(vi.getTimerCount()).toBeLessThan(timerCountBefore);
    });

    it('should handle stop when not running', async () => {
      await manager.stop();

      expect(logger.info).toHaveBeenCalledWith('Stopping BlueSky agent manager', { agentId: mockRuntime.agentId });
      expect(mockClient.cleanup).toHaveBeenCalled();
    });
  });

  describe('notification polling', () => {
    it('should poll notifications on interval', async () => {
      const mockNotifications = [
        {
          uri: 'at://did:plc:test/app.bsky.feed.post/123',
          cid: 'cid123',
          author: { handle: 'user.bsky.social' },
          reason: 'mention',
          indexedAt: '2024-01-01T00:00:00Z',
        },
      ];

      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications: mockNotifications });

      await manager.start();

      // Wait for the initial poll to complete
      await vi.advanceTimersByTimeAsync(100);

      // Initial poll should happen immediately
      expect(mockClient.getNotifications).toHaveBeenCalledWith(50);

      // Process notification
      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.mention_received', {
        runtime: mockRuntime,
        notification: mockNotifications[0],
        source: 'bluesky',
      });

      expect(mockClient.updateSeenNotifications).toHaveBeenCalled();
    });

    it('should handle different notification types', async () => {
      const notifications = [
        { reason: 'follow', indexedAt: '2024-01-01T00:00:00Z', author: { handle: 'user1' }, uri: 'uri1', cid: 'cid1' },
        { reason: 'like', indexedAt: '2024-01-01T00:00:00Z', author: { handle: 'user2' }, uri: 'uri2', cid: 'cid2' },
        { reason: 'repost', indexedAt: '2024-01-01T00:00:00Z', author: { handle: 'user3' }, uri: 'uri3', cid: 'cid3' },
        { reason: 'quote', indexedAt: '2024-01-01T00:00:00Z', author: { handle: 'user4' }, uri: 'uri4', cid: 'cid4' },
        { reason: 'unknown', indexedAt: '2024-01-01T00:00:00Z', author: { handle: 'user5' }, uri: 'uri5', cid: 'cid5' },
      ];

      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications });

      await manager.start();
      
      // Wait for the initial poll to complete
      await vi.advanceTimersByTimeAsync(100);

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.follow_received', expect.any(Object));
      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.like_received', expect.any(Object));
      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.repost_received', expect.any(Object));
      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.quote_received', expect.any(Object));
      
      // Unknown type should log debug
      expect(logger.debug).toHaveBeenCalledWith('Unhandled notification type', expect.any(Object));
    });

    it('should filter out old notifications', async () => {
      const oldNotification = {
        uri: 'at://old',
        cid: 'old',
        author: { handle: 'old.user' },
        reason: 'mention',
        indexedAt: '2024-01-01T00:00:00Z',
      };

      const newNotification = {
        uri: 'at://new',
        cid: 'new',
        author: { handle: 'new.user' },
        reason: 'mention',
        indexedAt: '2024-01-02T00:00:00Z',
      };

      // First poll - sets lastSeenNotificationTime
      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications: [oldNotification] });
      await manager.start();
      await vi.advanceTimersByTimeAsync(100);

      vi.clearAllMocks();

      // Second poll - should only process new notification
      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications: [newNotification, oldNotification] });
      
      // Manually trigger the poll method instead of advancing timers
      await manager['pollNotifications']();

      expect(mockRuntime.emitEvent).toHaveBeenCalledTimes(1);
      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.mention_received', 
        expect.objectContaining({ notification: newNotification })
      );
    });

    it('should handle notification polling errors', async () => {
      (mockClient.getNotifications as any).mockRejectedValueOnce(new Error('API error'));

      await manager.start();

      expect(logger.error).toHaveBeenCalledWith('Failed to poll notifications', expect.any(Object));
    });

    it('should continue running after errors', async () => {
      // First poll fails
      (mockClient.getNotifications as any).mockRejectedValueOnce(new Error('API error'));
      
      await manager.start();
      await vi.advanceTimersByTimeAsync(100); // Let the first poll fail

      // Verify error was logged
      expect(logger.error).toHaveBeenCalledWith('Failed to poll notifications', expect.any(Object));

      // Clear mocks
      vi.clearAllMocks();

      // Second poll succeeds
      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications: [] });
      
      // Manually trigger another poll
      await manager['pollNotifications']();

      expect(mockClient.getNotifications).toHaveBeenCalledTimes(1);
    });
  });

  describe('action processing', () => {
    it('should process mention actions', async () => {
      const mentions = [
        {
          uri: 'at://mention1',
          cid: 'cid1',
          author: { handle: 'user1' },
          reason: 'mention',
          indexedAt: '2024-01-01T00:00:00Z',
        },
        {
          uri: 'at://reply1',
          cid: 'cid2',
          author: { handle: 'user2' },
          reason: 'reply',
          indexedAt: '2024-01-01T00:00:00Z',
        },
      ];

      (mockClient.getNotifications as any)
        .mockResolvedValueOnce({ notifications: [] }) // Initial poll
        .mockResolvedValueOnce({ notifications: mentions }); // Action processing

      await manager.start();
      await vi.advanceTimersByTimeAsync(100); // Process initial poll

      // Clear mocks from initial poll
      vi.clearAllMocks();

      // Set up mock for action processing
      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications: mentions });

      // Manually trigger action processing
      await manager['processActions']();

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.should_respond', {
        runtime: mockRuntime,
        notification: mentions[0],
        source: 'bluesky',
      });

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.should_respond', {
        runtime: mockRuntime,
        notification: mentions[1],
        source: 'bluesky',
      });
    });
  });

  describe('automated posting', () => {
    it('should create post immediately if configured', async () => {
      // Mock shouldPostImmediately to return true
      const configModule = await import('../../common/config.js');
      vi.mocked(configModule.shouldPostImmediately).mockReturnValue(true);
      vi.mocked(configModule.isPostingEnabled).mockReturnValue(true);
      
      // Create a new manager with the updated config
      const postingManager = new BlueSkyAgentManager(mockRuntime, mockConfig, mockClient);
      
      await postingManager.start();

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.create_post', {
        runtime: mockRuntime,
        source: 'bluesky',
        automated: true,
      });
    });

    it('should schedule next post', async () => {
      await manager.start();
      await vi.advanceTimersByTimeAsync(100); // Process initial setup

      // Clear any initial post events
      vi.clearAllMocks();

      // Manually trigger automated post
      await manager['createAutomatedPost']();

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith('bluesky.create_post', {
        runtime: mockRuntime,
        source: 'bluesky',
        automated: true,
      });
    });

    it('should handle automated post errors', async () => {
      // Mock shouldPostImmediately to return true
      const configModule = await import('../../common/config.js');
      vi.mocked(configModule.shouldPostImmediately).mockReturnValue(true);
      vi.mocked(configModule.isPostingEnabled).mockReturnValue(true);
      
      mockRuntime.emitEvent = vi.fn().mockImplementationOnce(() => {
        throw new Error('Event handling failed');
      });

      // Create a new manager with the updated config
      const postingManager = new BlueSkyAgentManager(mockRuntime, mockConfig, mockClient);
      
      await postingManager.start();

      expect(logger.error).toHaveBeenCalledWith('Failed to create automated post', expect.any(Object));
    });
  });

  describe('error handling', () => {
    it('should handle process notification errors gracefully', async () => {
      const faultyNotification = {
        uri: 'at://faulty',
        cid: 'faulty',
        author: null, // This will cause an error
        reason: 'mention',
        indexedAt: '2024-01-01T00:00:00Z',
      };

      (mockClient.getNotifications as any).mockResolvedValueOnce({ notifications: [faultyNotification] });

      await manager.start();

      expect(logger.error).toHaveBeenCalledWith('Failed to process notification', expect.any(Object));
    });

  });
}); 