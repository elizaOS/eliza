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
 * Test suite for the community Manager agent
 * Tests onboarding and cross-platform functionality
 */

export class CommunityManagerTestSuite implements TestSuite {
  name = 'community-manager';
  description = 'Tests for the community manager agent';
  private scenarioService: any;

  private completionTimeout: number;

  constructor(completionTimeout: number = 10000) {
    this.completionTimeout = completionTimeout;
  }

  tests = [
    {
      name: 'Test Conflict Resolution',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Conflict Test', 'Test Owner');
        const roomId = await this.scenarioService.createRoom(worldId, 'general');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          "There's a user causing disruptions in the general channel"
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Agent did not resolve conflict in time');
        }
      },
    },
    {
      name: 'Test New User Onboarding',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Onboarding Test', 'Test Owner');
        const roomId = await this.scenarioService.createRoom(worldId, 'welcome');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const newUserId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, newUserId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          "Hi everyone, I'm new here!"
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Agent did not complete onboarding in time');
        }
      },
    },
    {
      name: 'Test Moderation Actions',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Moderation Test', 'Test Owner');
        const roomId = await this.scenarioService.createRoom(worldId, 'moderation');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          'This user posted inappropriate content'
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Agent did not handle moderation in time');
        }
      },
    },
    {
      name: 'Test Community Engagement',
      fn: async (runtime: IAgentRuntime) => {
        this.scenarioService = runtime.getService('scenario');
        if (!this.scenarioService) {
          throw new Error('Scenario service not found');
        }

        const worldId = await this.scenarioService.createWorld('Engagement Test', 'Test Owner');
        const roomId = await this.scenarioService.createRoom(worldId, 'events');

        await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
        const userId = uuidv4() as UUID;
        await this.scenarioService.addParticipant(worldId, roomId, userId);

        await this.scenarioService.sendMessage(
          runtime,
          worldId,
          roomId,
          "Let's plan the next community event"
        );

        const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
        if (!completed) {
          throw new Error('Agent did not engage in time');
        }
      },
    },
  ];
}
