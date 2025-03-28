// tests/communityManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunityManagerTestSuite } from './test_suites/CommunityManagerTestSuite';
import type { IAgentRuntime } from '@elizaos/core';

describe('CommunityManagerTestSuite', () => {
  let mockScenarioService: any;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockScenarioService = {
      createWorld: vi.fn().mockResolvedValue('world-id'),
      createRoom: vi.fn().mockResolvedValue('room-id'),
      addParticipant: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(true),
      waitForCompletion: vi.fn().mockResolvedValue(true),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockScenarioService),
      agentId: 'agent-id',
    } as unknown as IAgentRuntime;
  });

  describe('Core Functionality', () => {
    it('should resolve conflicts', async () => {
      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Conflict Resolution');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith('Conflict Test', 'Test Owner');
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'general');
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        "There's a user causing disruptions in the general channel"
      );
    });

    it('should handle new user onboarding', async () => {
      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test New User Onboarding');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'welcome');
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        "Hi everyone, I'm new here!"
      );
    });

    it('should perform moderation actions', async () => {
      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Moderation Actions');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith('Moderation Test', 'Test Owner');
      expect(mockScenarioService.waitForCompletion).toHaveBeenCalledWith(10000);
    });

    it('should drive community engagement', async () => {
      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Community Engagement');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        "Let's plan the next community event"
      );
    });
  });

  describe('Error Handling', () => {
    it('should throw when missing scenario service', async () => {
      const brokenRuntime = {
        ...mockRuntime,
        getService: vi.fn().mockReturnValue(undefined)
      };

      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Conflict Resolution');

      await expect(test?.fn(brokenRuntime)).rejects.toThrow('Scenario service not found');
    });

    it('should validate response timing', async () => {
      mockScenarioService.waitForCompletion.mockResolvedValue(false);

      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test New User Onboarding');

      await expect(test?.fn(mockRuntime)).rejects.toThrow(
        'Agent did not complete onboarding in time'
      );
    });
  });

  describe('Character Compliance', () => {
    it('should ignore off-topic messages', async () => {
      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Community Engagement');

      await test?.fn(mockRuntime);
      const messageContent = mockScenarioService.sendMessage.mock.calls[0][3];
      expect(messageContent).not.toContain('token price');
      expect(messageContent).not.toContain('marketing');
    });

    it('should maintain concise responses', async () => {
      const testSuite = new CommunityManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Conflict Resolution');

      await test?.fn(mockRuntime);
      const messageCalls = mockScenarioService.sendMessage.mock.calls;
      messageCalls.forEach((call: any[]) => {
        const message = call[3];
        expect(message.split(' ').length).toBeLessThan(20);
      });
    });
  });
});
