import type { Character, IAgentRuntime, TestSuite, UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

export class LiaisonTestSuite implements TestSuite {
    name = 'liaison';
    description = 'Tests for the community liaison agent';
    private scenarioService: any;
    private completionTimeout: number;

    constructor(completionTimeout: number = 10000) {
        this.completionTimeout = completionTimeout;
    }

    tests = [
        {
            name: 'Test Platform Information Request',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Platform Info Test', 'Test User');
                const roomId = await this.scenarioService.createRoom(worldId, 'general');

                await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "What's being discussed in the Telegram group about ElizaOS?"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Platform info response timed out');
            }
        },
        {
            name: 'Test Channel Recommendation',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Channel Test', 'Test User');
                const roomId = await this.scenarioService.createRoom(worldId, 'support');

                const response = await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Where should I ask about agent deployment?"
                );

                if (!response) throw new Error("sendMessage did not return a valid response");


                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Channel recommendation timed out');

                return response;
            }
        },
        {
            name: 'Test Cross-Platform Coordination',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Coordination Test', 'Test Organizer');
                const roomId = await this.scenarioService.createRoom(worldId, 'events');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Can you help coordinate a cross-platform hackathon?"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Coordination response timed out');
            }
        },
        {
            name: 'Test Announcement Management',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Announcement Test', 'Test Admin');
                const roomId = await this.scenarioService.createRoom(worldId, 'announcements');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Notify all platforms about the upcoming maintenance"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Announcement handling timed out');
            }
        },
        {
            name: 'Test Ignore Off-Topic',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Ignore Test', 'Test User');
                const roomId = await this.scenarioService.createRoom(worldId, 'general');

                const response = await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "I'm feeling anxious about my project deadline"
                );
                if (!response) return null;

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Ignore handling timed out');

                return response;
            }
        }
    ];
}

