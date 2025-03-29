// tests/liaison.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liaison } from '../src/liaison';
import type { IAgentRuntime } from '@elizaos/core';
import { LiaisonTestSuite } from './test_suites/LiasionTestSuite';

describe('LiaisonTestSuite', () => {
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
    it('should handle platform information requests', async () => {
      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Platform Information Request');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        'world-id',
        'room-id',
        expect.stringContaining('Telegram group')
      );
    });

    it('should provide channel recommendations', async () => {
      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Channel Recommendation');

      // Mock agent response
      mockScenarioService.sendMessage.mockImplementationOnce((_, __, ___, message) => {
        return Promise.resolve({
          content: {
            text: `${message}\nRecommended channels: Discord #deployment, Slack #elizaos-development`,
          },
        });
      });

      const response = await test?.fn(mockRuntime);
      const messages = mockScenarioService.sendMessage.mock.calls;
      expect(response.content.text).toContain(`Discord #deployment`);
    });
  });

  describe('Cross-Platform Coordination', () => {
    it('should handle cross-platform event setup', async () => {
      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Cross-Platform Coordination');

      await test?.fn(mockRuntime);
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        'world-id',
        'room-id',
        expect.stringContaining('hackathon')
      );
    });

    it('should manage multi-platform announcements', async () => {
      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Announcement Management');

      await test?.fn(mockRuntime);
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        'world-id',
        'room-id',
        expect.stringContaining('all platforms')
      );
    });
  });

  describe('Message Filtering', () => {
    it('should ignore off-topic messages', async () => {
      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Ignore Off-Topic');

      // Mock no response for off-topic messages
      mockScenarioService.sendMessage.mockImplementationOnce(() => Promise.resolve(null));

      const response = await test?.fn(mockRuntime);
      expect(response).toBe(null);
    });
  });

  describe('Configuration Validation', () => {
    it('should have correct plugins config', () => {
      expect(liaison.character.plugins).toContain('@elizaos/plugin-discord');
    });

    it('should maintain liaison response style', () => {
      expect(liaison.character.style?.all).toContain('Very short responses');
      expect(liaison.character.style?.chat).toContain('Focus on your job as a community liaison');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing scenario service', async () => {
      const brokenRuntime = {
        ...mockRuntime,
        getService: vi.fn().mockReturnValue(undefined),
      };

      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Platform Information Request');

      await expect(test?.fn(brokenRuntime)).rejects.toThrow('Scenario service not found');
    });

    it('should handle response timeouts', async () => {
      mockScenarioService.waitForCompletion.mockResolvedValue(false);

      const testSuite = new LiaisonTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Channel Recommendation');

      await expect(test?.fn(mockRuntime)).rejects.toThrow('Channel recommendation timed out');
    });
  });
});
