// tests/devRel.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DevRelTestSuite, devRel } from '../src/devRel';
import type { IAgentRuntime } from '@elizaos/core';

describe('devRel Agent Test Suite', () => {
  let mockScenarioService: any;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

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

  describe('Core Developer Support Functionality', () => {
    it('should handle technical documentation requests', async () => {
      const testSuite = new DevRelTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Documentation Query');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();

      expect(mockScenarioService.createWorld).toHaveBeenCalledWith('Doc Test', 'Test Developer');
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        "How do I implement custom actions in ElizaOS?"
      );
    });

    it('should assist with plugin integration', async () => {
      const testSuite = new DevRelTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Plugin Integration');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith('Plugin Test', 'Test Developer');
    });
  });

  describe('Knowledge Base Integration', () => {
    it('should reference documentation in responses', async () => {
      const testSuite = new DevRelTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Documentation Reference');

      // Setup mock response
      mockScenarioService.sendMessage.mockImplementationOnce((_: any, __: any, ___: any, msg: string) => {
        return Promise.resolve({ content: { text: `${msg}\nRefer to documentation: https://docs.elizaos.com` } });
      });

      await test?.fn(mockRuntime);

      const messages = mockScenarioService.sendMessage.mock.calls;
      expect(messages[0][3]).toMatch(/Refer to documentation/);
    });

    it('should access source code knowledge when enabled', async () => {
      vi.stubEnv('DEVREL_IMPORT_KNOWLEDGE', 'true');
      const testSuite = new DevRelTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Source Code Knowledge');

      // Setup mock response with source code reference
      mockScenarioService.sendMessage.mockImplementationOnce((_: any, __: any, ___: any, msg: string) => {
        return Promise.resolve({
          content: {
            text: `${msg}\nSource code location: src/elizaos/core/agent-runtime.ts`
          }
        });
      });

      await test?.fn(mockRuntime);

      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        expect.stringContaining('AgentRuntime')
      );
    });
  });

  describe('Configuration Validation', () => {
    it('should have correct developer-focused settings', () => {
      expect(devRel.character.settings?.DOCUMENTATION_SOURCES).toBeDefined();
      expect(devRel.character.plugins).toContain('@elizaos/plugin-discord');
    });

    it('should maintain technical response style', () => {
      expect(devRel.character.style?.all).toContain('clear');
      expect(devRel.character.style?.chat).toContain("chatty");
    });
  });

  describe('Error Handling', () => {
    it('should handle missing documentation paths', async () => {
      const testSuite = new DevRelTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Missing Documentation');

      mockScenarioService.sendMessage.mockRejectedValueOnce(
        new Error('Documentation not found')
      );

      await expect(test?.fn(mockRuntime)).rejects.toThrow('Documentation not found');
    });

    it('should handle codebase navigation errors', async () => {
      const testSuite = new DevRelTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Code Navigation');

      mockScenarioService.waitForCompletion.mockRejectedValueOnce(
        new Error('Could not locate code reference')
      );

      await expect(test?.fn(mockRuntime)).rejects.toThrow('Could not locate code reference');
    });
  });
});
