// tests/socialMediaManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { socialMediaManager } from '../src/socialMediaManager/index';
import type { IAgentRuntime } from '@elizaos/core';
import { SocialMediaManagerTestSuite } from './test_suites/SocialMediaManagerTestSuite';

describe('SocialMediaManagerTestSuite', () => {
  let mockScenarioService: any;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // Mock scenario service with Vitest's vi.fn()
    mockScenarioService = {
      createWorld: vi.fn().mockResolvedValue('world-id'),
      createRoom: vi.fn().mockResolvedValue('room-id'),
      addParticipant: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(true),
      waitForCompletion: vi.fn().mockResolvedValue(true),
    };

    // Mock runtime environment
    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockScenarioService),
      agentId: 'agent-id',
    } as unknown as IAgentRuntime;
  });

  describe('Core Functionality', () => {
    it('should complete onboarding process successfully', async () => {
      const testSuite = new SocialMediaManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Onboarding Process');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();

      // Verify service calls
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith(
        'Test Organization',
        'Test Owner'
      );
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'general');
      expect(mockScenarioService.addParticipant).toHaveBeenCalledTimes(2);
      expect(mockScenarioService.sendMessage).toHaveBeenCalled();
    });

    it('should handle cross-platform post creation', async () => {
      const testSuite = new SocialMediaManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Cross-Platform Post Creation');

      await test?.fn(mockRuntime);

      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        'Please create a post about our new product launch for Twitter and Discord'
      );
      expect(mockScenarioService.waitForCompletion).toHaveBeenCalledWith(10000);
    });

    it('should manage multiple user queries', async () => {
      const testSuite = new SocialMediaManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Response to User Queries');

      await test?.fn(mockRuntime);

      expect(mockScenarioService.sendMessage).toHaveBeenCalledTimes(3);
      expect(mockScenarioService.waitForCompletion).toHaveBeenCalledTimes(3);
    });
  });

  describe('Error Handling', () => {
    it('should throw error when missing scenario service', async () => {
      const brokenRuntime = {
        ...mockRuntime,
        getService: vi.fn().mockReturnValue(undefined),
      };

      const testSuite = new SocialMediaManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Onboarding Process');

      await expect(test?.fn(brokenRuntime)).rejects.toThrow('Scenario service not found');
    });

    it('should handle operation timeouts', async () => {
      mockScenarioService.waitForCompletion.mockResolvedValue(false);

      const testSuite = new SocialMediaManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Onboarding Process');

      await expect(test?.fn(mockRuntime)).rejects.toThrow(
        'Agent did not complete onboarding response in time'
      );
    });
  });
});
