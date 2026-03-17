#!/usr/bin/env bun

import {
    AgentRuntime,
    stringToUuid,
    ModelType,
    type IAgentRuntime,
    type Memory,
    type State,
} from '../../typescript/src/index';

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

// Import from local src
import {
    configureTrainingDependencies,
    TaskRunner,
    type CreateAgentParams,
    type IAgentRuntimeLike,
    type IAgentRuntimeManager,
    type IAgentService,
    type ITaskInteractor,
    type TrajectoryStepForTraining,
    type UserLike,
} from '../src';

// Implement Dependencies

class BenchmarkAgentService implements IAgentService {
    async createAgent(params: CreateAgentParams): Promise<UserLike> {
        // Return dummy user
        return {
            id: stringToUuid(params.name),
            username: params.name,
        };
    }
}

class BenchmarkRuntimeManager implements IAgentRuntimeManager {
    private runtimes = new Map<string, IAgentRuntime>();

    async getRuntime(agentId: string): Promise<IAgentRuntimeLike> {
        if (this.runtimes.has(agentId)) {
            return this.runtimes.get(agentId) as unknown as IAgentRuntimeLike;
        }

        // Create a new runtime
        const character = {
            name: 'BenchmarkAgent',
            bio: ['A helpful assistant for benchmarking.'],
            settings: {
                secrets: {
                    OPENAI_API_KEY: process.env.OPENAI_API_KEY || ''
                }
            }
        };

        const runtime = new AgentRuntime({
            character,
        });

        // We must initialize with allowNoDatabase to avoid DB error
        await runtime.initialize({ allowNoDatabase: true });

        // Register a mock model handler for TEXT_SMALL to allow generateText to work
        runtime.registerModel(
            ModelType.TEXT_SMALL,
            async (rt, params) => {
                return "This is a mock response from the benchmark script.";
            },
            "mock-provider",
            100
        );

        this.runtimes.set(agentId, runtime);

        return runtime as unknown as IAgentRuntimeLike;
    }

    async resetRuntime(agentId: string): Promise<void> {
        this.runtimes.delete(agentId);
    }
}

class BenchmarkTaskInteractor implements ITaskInteractor {
    async executeTask(
        agentRuntime: IAgentRuntimeLike,
        taskPrompt: string,
        options?: { maxTurns?: number; temperature?: number }
    ): Promise<{
        success: boolean;
        response: string;
        trajectoryId?: string;
        steps?: TrajectoryStepForTraining[];
        error?: string;
    }> {
        const runtime = agentRuntime as unknown as AgentRuntime;
        const trajectoryId = uuidv4();
        const startTime = Date.now();

        try {
            // 1. Create User Memory (in memory only, since we use no-db)
            const messageId = uuidv4();
            const userId = stringToUuid('user');
            const roomId = stringToUuid('benchmark-room');

            const userMemory: Memory = {
                id: messageId as `${string}-${string}-${string}-${string}-${string}`,
                entityId: userId as `${string}-${string}-${string}-${string}-${string}`,
                agentId: runtime.agentId,
                roomId: roomId as `${string}-${string}-${string}-${string}-${string}`,
                content: {
                    text: taskPrompt,
                },
                createdAt: Date.now(),
            };

            // Use standard createMemory method
            // createMemory(memory: Memory, tableName: string, unique?: boolean)
            await runtime.createMemory(userMemory, 'messages', true);

            // 2. Generate Response
            const state: State = await runtime.composeState(userMemory);

            const context = `You are ${runtime.character.name}.
${state.bio}
${state.lore}

User: ${taskPrompt}
Assistant:`;

            // Use generateText from runtime
            // Signature: generateText(input: string, options?: GenerateTextOptions)
            const result = await runtime.generateText(context, {
                modelType: ModelType.TEXT_SMALL,
                stopSequences: [],
            });
            // Handle both string and object return types for safety
            const response = typeof result === 'string' ? result : result.text;

            // Real implementation of logging:
            const steps: TrajectoryStepForTraining[] = [{
                stepId: uuidv4(),
                stepNumber: 1,
                timestamp: Date.now(),
                environmentState: { timestamp: Date.now(), agentPoints: 0 },
                observation: { userMessage: taskPrompt },
                providerAccesses: [],
                llmCalls: [],
                action: {
                    attemptId: uuidv4(),
                    timestamp: Date.now(),
                    actionType: 'text_response',
                    actionName: 'response',
                    parameters: { text: response },
                    success: true
                },
                reward: 0,
                done: true,
                metadata: {}
            }];

            // Log to File
            const trajectoryRecord = {
                id: uuidv4(),
                trajectoryId: trajectoryId,
                agentId: runtime.agentId,
                startTime: new Date(startTime).toISOString(),
                endTime: new Date().toISOString(),
                durationMs: Date.now() - startTime,
                steps,
                metadata: { task: taskPrompt },
                isTrainingData: true,
            };

            const logFile = path.resolve(process.cwd(), 'trajectories.jsonl');
            fs.appendFileSync(logFile, JSON.stringify(trajectoryRecord) + '\n');
            console.log(`Saved trajectory to ${logFile}`);

            return {
                success: true,
                response: String(response),
                trajectoryId,
                steps
            };

        } catch (e) {
            console.error('Error executing task', e);
            return {
                success: false,
                response: '',
                error: e instanceof Error ? e.message : String(e)
            };
        }
    }
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            task: { type: 'string', default: 'Hello, who are you?' },
            iterations: { type: 'string', default: '1' },
            model: { type: 'string', default: 'gpt-4o-mini' },
        },
    });

    const config = {
        agentName: 'BenchmarkBot',
        taskPrompt: values.task as string,
        //   bun packages/training/scripts/run_task_benchmark.ts --model "llama3.2" (requires Ollama running)
        iterations: parseInt(values.iterations as string, 10),
        model: values.model as string,
    };

    // Configure Dependencies
    configureTrainingDependencies({
        agentService: new BenchmarkAgentService(),
        agentRuntimeManager: new BenchmarkRuntimeManager(),
        autonomousCoordinator: {
            executeAutonomousTick: async () => ({ success: true }),
        },
        llmCaller: {
            callGroqDirect: async () => "mock response",
        },
    });

    // Import task interactor config
    const { configureTaskInteractor } = await import('../src/dependencies');
    configureTaskInteractor(new BenchmarkTaskInteractor());

    const runner = new TaskRunner(config);
    const results = await runner.run();

    console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
