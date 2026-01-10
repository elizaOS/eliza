import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlueSkyService } from '../../service.js';
import { BlueSkyClient } from '../../client.js';
import { BlueSkyAgentManager } from '../../managers/agent.js';
import { BlueSkyMessageService } from '../../services/MessageService.js';
import { BlueSkyPostService } from '../../services/PostService.js';
import { IAgentRuntime, Service, logger } from '@elizaos/core';
import { BLUESKY_SERVICE_NAME } from '../../common/constants.js';

// Mock dependencies
vi.mock('../../client.js');
vi.mock('../../managers/agent.js');
vi.mock('../../services/MessageService.js');
vi.mock('../../services/PostService.js');
vi.mock('@elizaos/core', () => ({
  Service: class Service {
    name: string = '';
    async initialize(runtime: IAgentRuntime): Promise<void> {}
    async cleanup(): Promise<void> {}
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock the config functions
vi.mock('../../common/config.js', () => ({
  hasBlueSkyEnabled: vi.fn(() => true),
  validateBlueSkyConfig: vi.fn((runtime: any) => {
    const handle = runtime.getSetting('BLUESKY_HANDLE');
    const password = runtime.getSetting('BLUESKY_PASSWORD');
    
    if (!handle || !password) {
      throw new Error('BlueSky configuration missing');
    }
    
    return {
      service: runtime.getSetting('BLUESKY_SERVICE') || 'https://bsky.social',
      handle,
      password,
      dryRun: runtime.getSetting('BLUESKY_DRY_RUN') === 'true',
    };
  }),
}));

describe('BlueSkyService', () => {
  let service: BlueSkyService;
  let mockRuntime: IAgentRuntime;
  let mockClient: BlueSkyClient;
  let mockManager: BlueSkyAgentManager;
  let mockMessageService: BlueSkyMessageService;
  let mockPostService: BlueSkyPostService;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Clear the singleton instance
    BlueSkyService.clearInstance();

    // Create mock runtime with proper UUID format
    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000123' as any,
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          BLUESKY_HANDLE: 'test.bsky.social',
          BLUESKY_PASSWORD: 'test-password',
          BLUESKY_SERVICE: 'https://bsky.social',
          BLUESKY_DRY_RUN: 'false',
        };
        return settings[key];
      }),
      registerAction: vi.fn(),
      registerEvent: vi.fn(),
      registerProvider: vi.fn(),
      getService: vi.fn(),
    } as any;

    // Create mocks
    mockClient = {
      authenticate: vi.fn(),
      cleanup: vi.fn(),
      getProfile: vi.fn(),
      sendPost: vi.fn(),
    } as any;

    mockManager = {
      start: vi.fn(),
      stop: vi.fn(),
      runtime: mockRuntime,
    } as any;

    mockMessageService = {} as any;
    mockPostService = {} as any;

    // Mock constructors
    vi.mocked(BlueSkyClient).mockImplementation(() => mockClient);
    vi.mocked(BlueSkyAgentManager).mockImplementation(() => mockManager);
    vi.mocked(BlueSkyMessageService).mockImplementation(() => mockMessageService);
    vi.mocked(BlueSkyPostService).mockImplementation(() => mockPostService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('static start', () => {
    it('should create and initialize service', async () => {
      const service = await BlueSkyService.start(mockRuntime);

      expect(service).toBeInstanceOf(BlueSkyService);
      expect(BlueSkyClient).toHaveBeenCalledWith({
        service: 'https://bsky.social',
        handle: 'test.bsky.social',
        password: 'test-password',
        dryRun: false,
      });

      expect(BlueSkyAgentManager).toHaveBeenCalledWith(
        mockRuntime,
        expect.objectContaining({
          service: 'https://bsky.social',
          handle: 'test.bsky.social',
          password: 'test-password',
          dryRun: false,
        }),
        mockClient
      );
      expect(BlueSkyMessageService).toHaveBeenCalledWith(mockClient, mockRuntime);
      expect(BlueSkyPostService).toHaveBeenCalledWith(mockClient, mockRuntime);
      expect(mockManager.start).toHaveBeenCalled();
    });

    it('should return existing service if already started', async () => {
      const service1 = await BlueSkyService.start(mockRuntime);
      const service2 = await BlueSkyService.start(mockRuntime);

      expect(service1).toBe(service2);
      expect(BlueSkyClient).toHaveBeenCalledTimes(1);
    });

    it('should handle manager start failure', async () => {
      (mockManager.start as any).mockRejectedValueOnce(new Error('Start failed'));

      // The service should still be created even if manager.start() fails
      const service = await BlueSkyService.start(mockRuntime);
      expect(service).toBeInstanceOf(BlueSkyService);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('static stop', () => {
    it('should stop the service for a runtime', async () => {
      await BlueSkyService.start(mockRuntime);
      await BlueSkyService.stop(mockRuntime);

      expect(mockManager.stop).toHaveBeenCalled();
    });

    it('should handle stop when service not running', async () => {
      await expect(BlueSkyService.stop(mockRuntime)).resolves.not.toThrow();
    });
  });

  describe('instance stop', () => {
    it('should stop all services', async () => {
      // Start multiple services
      const mockRuntime2: IAgentRuntime = {
        agentId: '00000000-0000-0000-0000-000000000456' as any,
        getSetting: mockRuntime.getSetting,
        registerAction: vi.fn(),
        registerEvent: vi.fn(),
        registerProvider: vi.fn(),
        getService: vi.fn(),
      } as any;

      // Create separate mocks for the second agent
      const mockManager2 = {
        start: vi.fn(),
        stop: vi.fn(),
        runtime: mockRuntime2,
      } as any;

      // Mock the constructor to return different managers
      vi.mocked(BlueSkyAgentManager)
        .mockImplementationOnce(() => mockManager)
        .mockImplementationOnce(() => mockManager2);

      const service = await BlueSkyService.start(mockRuntime);
      await BlueSkyService.start(mockRuntime2);

      // Stop all
      await service.stop();

      expect(mockManager.stop).toHaveBeenCalledTimes(1);
      expect(mockManager2.stop).toHaveBeenCalledTimes(1);
    });

    it('should handle errors when stopping services', async () => {
      const service = await BlueSkyService.start(mockRuntime);
      (mockManager.stop as any).mockRejectedValueOnce(new Error('Stop failed'));

      // Should not throw
      await expect(service.stop()).resolves.not.toThrow();
    });
  });

  describe('getMessageService', () => {
    it('should return message service for initialized agent', async () => {
      const service = await BlueSkyService.start(mockRuntime) as BlueSkyService;
      
      const messageService = service.getMessageService(mockRuntime.agentId);
      expect(messageService).toBe(mockMessageService);
    });

    it('should return undefined for uninitialized agent', async () => {
      const service = await BlueSkyService.start(mockRuntime) as BlueSkyService;
      const messageService = service.getMessageService('unknown-agent' as any);
      expect(messageService).toBeUndefined();
    });
  });

  describe('getPostService', () => {
    it('should return post service for initialized agent', async () => {
      const service = await BlueSkyService.start(mockRuntime) as BlueSkyService;
      
      const postService = service.getPostService(mockRuntime.agentId);
      expect(postService).toBe(mockPostService);
    });

    it('should return undefined for uninitialized agent', async () => {
      const service = await BlueSkyService.start(mockRuntime) as BlueSkyService;
      const postService = service.getPostService('unknown-agent' as any);
      expect(postService).toBeUndefined();
    });
  });

  describe('service configuration', () => {
    it('should handle missing configuration gracefully', async () => {
      mockRuntime.getSetting = vi.fn(() => undefined);

      // hasBlueSkyEnabled should return false when config is missing
      const { hasBlueSkyEnabled } = await import('../../common/config.js');
      vi.mocked(hasBlueSkyEnabled).mockReturnValueOnce(false);
      
      const service = await BlueSkyService.start(mockRuntime);
      expect(service).toBeInstanceOf(BlueSkyService);
      expect(BlueSkyClient).not.toHaveBeenCalled();
    });

    it('should parse boolean dry run setting correctly', async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_DRY_RUN') return 'true';
        return {
          BLUESKY_HANDLE: 'test.bsky.social',
          BLUESKY_PASSWORD: 'test-password',
          BLUESKY_SERVICE: 'https://bsky.social',
        }[key];
      });

      await BlueSkyService.start(mockRuntime);

      expect(BlueSkyClient).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
        })
      );
    });
  });

  describe('multiple agents', () => {
    it('should handle multiple agents independently', async () => {
      const mockRuntime2: IAgentRuntime = {
        agentId: '00000000-0000-0000-0000-000000000456' as any,
        getSetting: mockRuntime.getSetting,
        registerAction: vi.fn(),
        registerEvent: vi.fn(),
        registerProvider: vi.fn(),
        getService: vi.fn(),
      } as any;

      // Need to create separate mocks for the second agent
      const mockClient2 = {
        authenticate: vi.fn(),
        cleanup: vi.fn(),
        getProfile: vi.fn(),
        sendPost: vi.fn(),
      } as any;

      const mockManager2 = {
        start: vi.fn(),
        stop: vi.fn(),
        runtime: mockRuntime2,
      } as any;

      const mockMessageService2 = {} as any;
      const mockPostService2 = {} as any;

      // Mock constructors to return different instances for different calls
      vi.mocked(BlueSkyClient)
        .mockImplementationOnce(() => mockClient)
        .mockImplementationOnce(() => mockClient2);
      vi.mocked(BlueSkyAgentManager)
        .mockImplementationOnce(() => mockManager)
        .mockImplementationOnce(() => mockManager2);
      vi.mocked(BlueSkyMessageService)
        .mockImplementationOnce(() => mockMessageService)
        .mockImplementationOnce(() => mockMessageService2);
      vi.mocked(BlueSkyPostService)
        .mockImplementationOnce(() => mockPostService)
        .mockImplementationOnce(() => mockPostService2);

      const service = await BlueSkyService.start(mockRuntime) as BlueSkyService;
      await BlueSkyService.start(mockRuntime2);

      // Each runtime should have its own instances
      const messageService1 = service.getMessageService(mockRuntime.agentId);
      const messageService2 = service.getMessageService(mockRuntime2.agentId);
      expect(messageService1).toBe(mockMessageService);
      expect(messageService2).toBe(mockMessageService2);
      expect(messageService1).not.toBe(messageService2);

      const postService1 = service.getPostService(mockRuntime.agentId);
      const postService2 = service.getPostService(mockRuntime2.agentId);
      expect(postService1).toBe(mockPostService);
      expect(postService2).toBe(mockPostService2);
      expect(postService1).not.toBe(postService2);

      // Should have created two clients
      expect(BlueSkyClient).toHaveBeenCalledTimes(2);
    });
  });
}); 