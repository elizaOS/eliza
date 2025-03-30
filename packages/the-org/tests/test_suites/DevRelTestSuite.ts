import type {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  ProjectAgent,
  TestSuite,
  UUID,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Test suite for the devRel agent
 * Tests onboarding and cross-platform functionality
 */

export class DevRelTestSuite implements TestSuite {
  name = 'devrel';
  description = 'Developer Relations Agent Test Suite';
  private scenarioService: any;

  private completionTimeout: number;

  constructor(completionTimeout: number = 10000) {
    this.completionTimeout = completionTimeout;
  }

  tests = [
    {
      name: 'Test Documentation Query',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) throw new Error('Scenario service missing');

        const worldId = await this.scenarioService.createWorld('Doc Test', 'Test Developer');
        const roomId = await this.scenarioService.createRoom(worldId, 'support');

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'How do I implement custom actions in ElizaOS?'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) throw new Error('Documentation response timeout');
      },
    },
    {
      name: 'Test Plugin Integration',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) throw new Error('Scenario service missing');

        const worldId = await this.scenarioService.createWorld('Plugin Test', 'Test Developer');
        const roomId = await this.scenarioService.createRoom(worldId, 'integration');

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Can you help me integrate the Discord plugin?'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) throw new Error('Plugin integration timeout');
      },
    },
    {
      name: 'Test Source Code Knowledge',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) throw new Error('Scenario service missing');

        const worldId = await this.scenarioService.createWorld('Code Test', 'Test Developer');
        const roomId = await this.scenarioService.createRoom(worldId, 'code-review');

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Where is the AgentRuntime class implemented?'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) throw new Error('Source code reference timeout');
      },
    },
    {
      name: 'Test Missing Documentation',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) throw new Error('Scenario service missing');

        const worldId = await this.scenarioService.createWorld('Doc Test', 'Test Developer');
        const roomId = await this.scenarioService.createRoom(worldId, 'support');

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'How do I implement custom actions in ElizaOS?'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) throw new Error('Documentation not found');
      },
    },
    {
      name: 'Test Code Navigation',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) throw new Error('Scenario service missing');

        const worldId = await this.scenarioService.createWorld('Code Test', 'Test Developer');
        const roomId = await this.scenarioService.createRoom(worldId, 'code-review');

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'Where is the AgentRuntime class implemented?'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) throw new Error('Could not locate code reference');
      },
    },
    {
      name: 'Test Documentation Reference',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) throw new Error('Scenario service missing');

        const worldId = await this.scenarioService.createWorld('Doc Test', 'Test Developer');
        const roomId = await this.scenarioService.createRoom(worldId, 'support');

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'How do I implement custom actions in ElizaOS?'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) throw new Error('Documentation reference missing');
      },
    },
  ];
}
