// tests/projectManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { projectManager } from '../src/projectManager';
import type { IAgentRuntime } from '@elizaos/core';
import { ProjectManagerTestSuite } from './test_suites/ProjectManagerTestSuite';

describe('ProjectManagerTestSuite', () => {
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
    it('should handle project creation', async () => {
      const testSuite = new ProjectManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Project Creation');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith(
        'Project Setup Test',
        'Test Client'
      );
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        'world-id',
        'room-id',
        'Create a new project for CRM implementation'
      );
    });

    it('should manage task assignments', async () => {
      const testSuite = new ProjectManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Task Assignment');

      await test?.fn(mockRuntime);
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'task-management');
    });
  });

  describe('Reporting & Communication', () => {
    it('should generate status reports', async () => {
      const testSuite = new ProjectManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Status Reporting');

      await test?.fn(mockRuntime);
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        'world-id',
        'room-id',
        'Generate weekly progress report for executive review'
      );
    });

    it('should schedule meetings', async () => {
      const testSuite = new ProjectManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Meeting Scheduling');

      await test?.fn(mockRuntime);
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'meetings');
    });
  });

  describe('Configuration Validation', () => {
    it('should have required project management plugins', () => {
      expect(projectManager.character.plugins).toEqual(
        expect.arrayContaining([
          '@elizaos/plugin-sql',
          '@elizaos/plugin-discord',
          '@elizaos/plugin-pdf',
        ])
      );
    });

    it('should maintain professional communication style', () => {
      expect(projectManager.character.style.all).toContain(
        'Use clear, concise, and professional language'
      );
      expect(projectManager.character.style.chat).toContain("Don't be annoying or verbose");
    });
  });

  describe('Error Handling', () => {
    it('should handle missing scenario service', async () => {
      const brokenRuntime = {
        ...mockRuntime,
        getService: vi.fn().mockReturnValue(undefined),
      };

      const testSuite = new ProjectManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Project Creation');

      await expect(test?.fn(brokenRuntime)).rejects.toThrow('Scenario service not found');
    });

    it('should handle report generation timeouts', async () => {
      mockScenarioService.waitForCompletion.mockResolvedValue(false);

      const testSuite = new ProjectManagerTestSuite();
      const test = testSuite.tests.find((t) => t.name === 'Test Status Reporting');

      await expect(test?.fn(mockRuntime)).rejects.toThrow('Status report generation timed out');
    });
  });
});
