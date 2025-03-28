import { logger } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasFarcasterEnabled, validateFarcasterConfig } from '../src/common/config';
import { FarcasterAgentManager } from '../src/managers/agent';
import { FarcasterService } from '../src/service';

// Create mock implementation for required dependencies
vi.mock('@elizaos/core', () => {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    Service: class MockService {
      async stop() {}
    },
    stringToUUID: (str) => str,
    UUID: String,
  };
});

vi.mock('../src/managers/agent', () => {
  return {
    FarcasterAgentManager: vi.fn().mockImplementation(() => {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        runtime: {
          agentId: 'mock-agent-id',
        },
      };
    }),
  };
});

vi.mock('../src/common/config', () => {
  return {
    hasFarcasterEnabled: vi.fn(),
    validateFarcasterConfig: vi.fn().mockReturnValue({
      FARCASTER_FID: 12345,
      FARCASTER_NEYNAR_SIGNER_UUID: 'mock-signer-uuid',
      FARCASTER_NEYNAR_API_KEY: 'mock-api-key',
    }),
  };
});

describe('FarcasterService', () => {
  let mockRuntime: any;
  let instanceCleanup: FarcasterService;

  beforeEach(() => {
    mockRuntime = {
      agentId: 'mock-agent-id',
      getSetting: vi.fn((key) => {
        const settings: Record<string, string> = {
          FARCASTER_FID: '12345',
          FARCASTER_NEYNAR_SIGNER_UUID: 'mock-signer-uuid',
          FARCASTER_NEYNAR_API_KEY: 'mock-api-key',
        };
        return settings[key] || '';
      }),
    };

    // Ensure we reset all mocks before each test
    vi.clearAllMocks();

    // Reset the singleton instance before each test
    instanceCleanup = new FarcasterService();
    // @ts-ignore - accessing private property for test
    FarcasterService.instance = undefined;
  });

  afterEach(async () => {
    // Clean up remaining instances between tests
    await instanceCleanup.stop();
  });

  describe('start', () => {
    it('should start a new Farcaster service when enabled', async () => {
      // Mock that Farcaster is enabled
      (hasFarcasterEnabled as any).mockReturnValue(true);

      const service = await FarcasterService.start(mockRuntime);

      expect(hasFarcasterEnabled).toHaveBeenCalledWith(mockRuntime);
      expect(validateFarcasterConfig).toHaveBeenCalledWith(mockRuntime);
      expect(FarcasterAgentManager).toHaveBeenCalled();
      expect(logger.success).toHaveBeenCalledWith('Farcaster client started', 'mock-agent-id');

      // Verify we have a manager for this agent
      const managers = (service as any).managers;
      expect(managers.has('mock-agent-id')).toBe(true);

      // Verify manager.start was called
      const manager = managers.get('mock-agent-id');
      expect(manager.start).toHaveBeenCalled();
    });

    it('should not start when Farcaster is not enabled', async () => {
      // Mock that Farcaster is disabled
      (hasFarcasterEnabled as any).mockReturnValue(false);

      const service = await FarcasterService.start(mockRuntime);

      expect(hasFarcasterEnabled).toHaveBeenCalledWith(mockRuntime);
      expect(validateFarcasterConfig).not.toHaveBeenCalled();
      expect(FarcasterAgentManager).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('Farcaster service not enabled', 'mock-agent-id');

      // Verify we don't have a manager for this agent
      const managers = (service as any).managers;
      expect(managers.has('mock-agent-id')).toBe(false);
    });

    it('should not start when service is already running', async () => {
      // Mock that Farcaster is enabled
      (hasFarcasterEnabled as any).mockReturnValue(true);

      // Start the service once
      const service1 = await FarcasterService.start(mockRuntime);

      // FarcasterAgentManager should have been called once
      expect(FarcasterAgentManager).toHaveBeenCalledTimes(1);

      // Reset mocks to verify new calls clearly
      vi.clearAllMocks();

      // Start again with same runtime
      const service2 = await FarcasterService.start(mockRuntime);

      // Should warn about already started
      expect(logger.warn).toHaveBeenCalledWith(
        'Farcaster service already started',
        'mock-agent-id'
      );

      // Should not create a new manager
      expect(FarcasterAgentManager).toHaveBeenCalledTimes(0);

      // Both services should be the same instance
      expect(service1).toBe(service2);
    });
  });

  describe('stop (single agent)', () => {
    it('should stop a running Farcaster service', async () => {
      // Mock that Farcaster is enabled and start the service
      (hasFarcasterEnabled as any).mockReturnValue(true);
      await FarcasterService.start(mockRuntime);

      // Clear mocks before stopping
      vi.clearAllMocks();

      // Stop the service
      await FarcasterService.stop(mockRuntime);

      // Check that manager.stop was called
      const service = new FarcasterService();
      const managers = (service as any).managers;
      expect(managers.has('mock-agent-id')).toBe(false);
      expect(logger.info).toHaveBeenCalledWith('Farcaster client stopped', 'mock-agent-id');
    });

    it('should handle stopping a non-running service', async () => {
      // Try to stop a service that was never started
      await FarcasterService.stop(mockRuntime);

      expect(logger.debug).toHaveBeenCalledWith('Farcaster service not running', 'mock-agent-id');
    });
  });

  describe('stop (all agents)', () => {
    it('should stop all running Farcaster services', async () => {
      // Create multiple mock runtimes
      const mockRuntime1 = { ...mockRuntime, agentId: 'agent-1' };
      const mockRuntime2 = { ...mockRuntime, agentId: 'agent-2' };

      // Mock that Farcaster is enabled
      (hasFarcasterEnabled as any).mockReturnValue(true);

      // Start services for multiple agents
      await FarcasterService.start(mockRuntime1);
      await FarcasterService.start(mockRuntime2);

      // Reset mocks before testing stop
      vi.clearAllMocks();

      // Stop all services
      const service = new FarcasterService();
      await service.stop();

      // Check managers were cleared
      const managers = (service as any).managers;
      expect(managers.size).toBe(0);
      expect(logger.debug).toHaveBeenCalledWith('Stopping ALL Farcaster services');
    });

    it('should handle errors when stopping services', async () => {
      // Mock that Farcaster is enabled
      (hasFarcasterEnabled as any).mockReturnValue(true);

      // Start a service
      const service = await FarcasterService.start(mockRuntime);

      // Get the manager and mock stop to throw error
      const managers = (service as any).managers;
      const manager = managers.get('mock-agent-id');
      manager.stop.mockRejectedValueOnce(new Error('Stop failed'));

      // Reset mocks to see new calls clearly
      vi.clearAllMocks();

      // Stop all services
      await service.stop();

      // Should log the error
      expect(logger.error).toHaveBeenCalledWith(
        'Error stopping Farcaster service',
        'mock-agent-id',
        expect.any(Error)
      );
    });
  });

  it('should have the correct service type and capability description', () => {
    expect(FarcasterService.serviceType).toBe('farcaster');

    const service = new FarcasterService();
    expect(service.capabilityDescription).toBe(
      'The agent is able to send and receive messages on farcaster'
    );
  });
});
