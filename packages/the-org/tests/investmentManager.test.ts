// tests/investmentManager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvestmentManagerTestSuite } from './test_suites/investmentManagerTestSuite';
import type { IAgentRuntime } from '@elizaos/core';

describe('InvestmentManagerTestSuite', () => {
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

  describe('Core Investment Functions', () => {
    it('should handle portfolio rebalancing', async () => {
      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Portfolio Rebalancing');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith('Portfolio Test', 'Test Investor');
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'trading');
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        "Rebalance portfolio to 60% equities and 40% bonds"
      );
    });

    it('should execute trades correctly', async () => {
      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Trade Execution');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createWorld).toHaveBeenCalledWith('Trading Test', 'Test Trader');
    });
  });

  describe('Risk Management', () => {
    it('should perform risk assessments', async () => {
      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Risk Assessment');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.sendMessage).toHaveBeenCalledWith(
        mockRuntime,
        'world-id',
        'room-id',
        "Analyze portfolio risk exposure and suggest mitigation strategies"
      );
    });
  });

  describe('Compliance Checks', () => {
    it('should verify regulatory compliance', async () => {
      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Compliance Check');

      await expect(test?.fn(mockRuntime)).resolves.not.toThrow();
      expect(mockScenarioService.createRoom).toHaveBeenCalledWith('world-id', 'regulatory');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing scenario service', async () => {
      const brokenRuntime = {
        ...mockRuntime,
        getService: vi.fn().mockReturnValue(undefined)
      };

      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Portfolio Rebalancing');

      await expect(test?.fn(brokenRuntime)).rejects.toThrow('Scenario service not found');
    });

    it('should handle operation timeouts', async () => {
      mockScenarioService.waitForCompletion.mockResolvedValue(false);

      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Trade Execution');

      await expect(test?.fn(mockRuntime)).rejects.toThrow('Trade execution timed out');
    });
  });

  describe('Performance Metrics', () => {
    it('should complete compliance checks within 15 seconds', async () => {
      const testSuite = new InvestmentManagerTestSuite();
      const test = testSuite.tests.find(t => t.name === 'Test Compliance Check');

      const start = Date.now();
      await test?.fn(mockRuntime);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(15000);
    });
  });
});
