import type { IAgentRuntime, TestSuite, UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Test suite for the Social Media Manager agent
 * Tests onboarding and cross-platform functionality
 */
export class SocialMediaManagerTestSuite implements TestSuite {
    name = 'social-media-manager';
    description = 'Tests for the social media manager agent';
    private scenarioService: any;

    private completionTimeout: number;


    constructor(completionTimeout: number = 10000) {
        this.completionTimeout = completionTimeout;
    }
    tests = [
        {
            name: 'Test Onboarding Process',
            fn: async (runtime: IAgentRuntime) => {
                // Initialize scenario service
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) {
                    throw new Error('Scenario service not found');
                }

                // Create test world with owner
                const worldId = await this.scenarioService.createWorld('Test Organization', 'Test Owner');

                // Create main room for onboarding
                const mainRoomId = await this.scenarioService.createRoom(worldId, 'general');

                // Add the agent and owner to the room
                await this.scenarioService.addParticipant(worldId, mainRoomId, runtime.agentId);
                const ownerId = uuidv4() as UUID;
                await this.scenarioService.addParticipant(worldId, mainRoomId, ownerId);

                // Simulate owner sending onboarding message
                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    mainRoomId,
                    "Hi! I'd like to set up social media management for my organization."
                );

                // Wait for agent to process and respond
                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) {
                    throw new Error('Agent did not complete onboarding response in time');
                }
            },
        },
        {
            name: 'Test Cross-Platform Post Creation',
            fn: async (runtime: IAgentRuntime) => {

                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) {
                    throw new Error('Scenario service not found');
                }

                // Create test world and room
                const worldId = await this.scenarioService.createWorld('Cross-Platform Test', 'Test Owner');
                const roomId = await this.scenarioService.createRoom(worldId, 'social-media');

                // Add participants
                await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
                const ownerId = uuidv4() as UUID;
                await this.scenarioService.addParticipant(worldId, roomId, ownerId);

                // Request cross-platform post
                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    'Please create a post about our new product launch for Twitter and Discord'
                );

                // Wait for agent to process request and generate posts
                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) {
                    throw new Error('Agent did not complete post creation in time');
                }
            },
        },
        {
            name: 'Test Response to User Queries',
            fn: async (runtime: IAgentRuntime) => {

                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) {
                    throw new Error('Scenario service not found');
                }

                // Create test environment
                const worldId = await this.scenarioService.createWorld('Query Test', 'Test Owner');
                const roomId = await this.scenarioService.createRoom(worldId, 'help');

                // Add participants
                await this.scenarioService.addParticipant(worldId, roomId, runtime.agentId);
                const ownerId = uuidv4() as UUID;
                await this.scenarioService.addParticipant(worldId, roomId, ownerId);

                // Send test queries
                const queries = [
                    'What social media platforms do you support?',
                    'Can you help me schedule posts?',
                    'How do you handle engagement metrics?',
                ];

                for (const query of queries) {
                    await this.scenarioService.sendMessage(runtime, worldId, roomId, query);

                    // Wait for agent to process and respond to each query
                    const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                    if (!completed) {
                        throw new Error(`Agent did not respond to query in time: ${query}`);
                    }
                }
            },
        },
    ];
}