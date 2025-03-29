import type { IAgentRuntime, TestSuite, UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

export class ProjectManagerTestSuite implements TestSuite {
    name = 'project-manager';
    description = 'Tests for the project manager agent';
    private scenarioService: any;
    private completionTimeout: number;

    constructor(completionTimeout: number = 15000) {
        this.completionTimeout = completionTimeout;
    }

    tests = [
        {
            name: 'Test Project Creation',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Project Setup Test', 'Test Client');
                const roomId = await this.scenarioService.createRoom(worldId, 'project-setup');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Create a new project for CRM implementation"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Project creation timed out');
            }
        },
        {
            name: 'Test Task Assignment',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Task Management Test', 'Test Team Lead');
                const roomId = await this.scenarioService.createRoom(worldId, 'task-management');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Assign UI development tasks to Alice and Bob"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Task assignment timed out');
            }
        },
        {
            name: 'Test Status Reporting',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Reporting Test', 'Test Stakeholder');
                const roomId = await this.scenarioService.createRoom(worldId, 'reports');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Generate weekly progress report for executive review"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Status report generation timed out');
            }
        },
        {
            name: 'Test Meeting Scheduling',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('Scheduling Test', 'Test Coordinator');
                const roomId = await this.scenarioService.createRoom(worldId, 'meetings');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "Schedule sprint planning meeting for next Monday"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Meeting scheduling timed out');
            }
        },
        {
            name: 'Test Off-Topic Handling',
            fn: async (runtime: IAgentRuntime) => {
                this.scenarioService = runtime.getService('scenario');
                if (!this.scenarioService) throw new Error('Scenario service not found');

                const worldId = await this.scenarioService.createWorld('OffTopic Test', 'Test User');
                const roomId = await this.scenarioService.createRoom(worldId, 'general');

                await this.scenarioService.sendMessage(
                    runtime,
                    worldId,
                    roomId,
                    "What's the weather forecast for tomorrow?"
                );

                const completed = await this.scenarioService.waitForCompletion(this.completionTimeout);
                if (!completed) throw new Error('Off-topic handling timed out');
            }
        }
    ];
}
