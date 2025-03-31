import type { Character, IAgentRuntime, TestSuite, UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Test suite for the Investment Manager agent
 * Tests portfolio management and financial operations
 */
export class InvestmentManagerTestSuite implements TestSuite {
  name = 'investment-manager';
  description = 'Tests for the investment manager agent';
  private scenarioService: any;
  private completionTimeout: number;

  constructor(completionTimeout: number = 15000) {
    this.completionTimeout = completionTimeout;
  }

  tests = [
    {
      name: 'Test Portfolio Rebalancing',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Portfolio Test', 'Test Investor');
        const roomId = await this.scenarioService.createRoom(worldId, 'trading');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Rebalance portfolio to 60% equities and 40% bonds'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Portfolio rebalancing timed out');
        }
      },
    },
    {
      name: 'Test Trade Execution',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Trading Test', 'Test Trader');
        const roomId = await this.scenarioService.createRoom(worldId, 'execution');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Execute buy order for 1000 shares of AAPL at market price'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Trade execution timed out');
        }
      },
    },
    {
      name: 'Test Risk Assessment',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Risk Test', 'Test Analyst');
        const roomId = await this.scenarioService.createRoom(worldId, 'analysis');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Analyze portfolio risk exposure and suggest mitigation strategies'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Risk assessment timed out');
        }
      },
    },
    {
      name: 'Test Compliance Check',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Compliance Test', 'Test Auditor');
        const roomId = await this.scenarioService.createRoom(worldId, 'regulatory');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Verify all trades comply with SEC regulations'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Compliance check timed out');
        }
      },
    },
  ];
}
