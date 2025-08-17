/**
 * Tests for Non-Invasive Trajectory Reconstruction (Ticket #5785)
 * 
 * These tests validate that we can reconstruct agent trajectory from
 * existing database logs and memories WITHOUT modifying the core runtime.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { TrajectoryReconstructor, TrajectoryStep } from '../TrajectoryReconstructor';
import { UUID } from '@elizaos/core';

// Mock runtime for testing
const mockRuntime = {
    agentId: 'test-agent-id' as UUID,
    getLogs: mock(() => Promise.resolve([])),
    getMemories: mock(() => Promise.resolve([]))
};

describe('TrajectoryReconstructor - Non-Invasive Approach', () => {
    let reconstructor: TrajectoryReconstructor;
    const testRoomId = 'test-room-id' as UUID;

    beforeEach(() => {
        reconstructor = new TrajectoryReconstructor(mockRuntime as any);
        mockRuntime.getLogs.mockClear();
        mockRuntime.getMemories.mockClear();
    });

    describe('Basic Functionality', () => {
        it('should create reconstructor instance', () => {
            expect(reconstructor).toBeDefined();
            expect(reconstructor).toBeInstanceOf(TrajectoryReconstructor);
        });

        it('should handle empty logs gracefully', async () => {
            mockRuntime.getLogs.mockResolvedValue([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory).toBeDefined();
            expect(trajectory.steps).toEqual([]);
            expect(trajectory.totalSteps).toBe(0);
        });
    });

    describe('Log-Based Trajectory Reconstruction', () => {
        it('should reconstruct thought steps from action plans', async () => {
            const mockActionLogs = [{
                id: 'log-1' as UUID,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:01Z'),
                body: {
                    action: 'test-action',
                    planThought: 'I need to help the user with their request',
                    runId: 'run-123'
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs); // action logs
            mockRuntime.getLogs.mockResolvedValueOnce([]); // model logs  
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(2); // thought + action

            const thoughtStep = trajectory.steps[0];
            expect(thoughtStep.type).toBe('thought');
            expect(thoughtStep.content).toBe('I need to help the user with their request');
            expect(thoughtStep.timestamp).toBe('2023-10-27T10:00:01.000Z');
        });

        it('should reconstruct action steps from action logs', async () => {
            const mockActionLogs = [{
                id: 'log-2' as UUID,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:02Z'),
                body: {
                    action: 'send-message',
                    message: 'Hello world',
                    state: { data: { userInput: 'test' } },
                    runId: 'run-123'
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(1);

            const actionStep = trajectory.steps[0];
            expect(actionStep.type).toBe('action');
            expect(actionStep.content.name).toBe('send-message');
            expect(actionStep.content.parameters.input).toBe('Hello world');
            expect(actionStep.content.parameters.userInput).toBe('test');
        });

        it('should reconstruct observation steps from action results', async () => {
            const mockActionLogs = [{
                id: 'log-3' as UUID,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:03Z'),
                body: {
                    action: 'send-message',
                    result: {
                        success: true,
                        text: 'Message sent successfully',
                        data: { messageId: 'msg-123' }
                    },
                    runId: 'run-123'
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(2); // action + observation

            const observationStep = trajectory.steps[1];
            expect(observationStep.type).toBe('observation');
            expect(observationStep.content.success).toBe(true);
            expect(observationStep.content.text).toBe('Message sent successfully');
            expect(observationStep.content.data.messageId).toBe('msg-123');
        });
    });

    describe('Memory-Based Trajectory Reconstruction', () => {
        it('should supplement trajectory from action memories', async () => {
            const mockActionMemories = [{
                id: 'mem-1' as UUID,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                createdAt: 1698397203000, // 2023-10-27T10:00:03Z
                content: {
                    type: 'action_result',
                    actionName: 'backup-action',
                    actionResult: {
                        success: true,
                        text: 'Backup completed'
                    }
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(1);

            const observationStep = trajectory.steps[0];
            expect(observationStep.type).toBe('observation');
            expect(observationStep.content.success).toBe(true);
            expect(observationStep.content.text).toBe('Backup completed');
        });
    });

    describe('Complete Trajectory Flow', () => {
        it('should reconstruct complete thought->action->observation flow', async () => {
            const mockActionLogs = [{
                id: 'log-complete' as UUID,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:00Z'),
                body: {
                    action: 'help-user',
                    planThought: 'User needs assistance with their query',
                    message: 'How can I help you?',
                    result: {
                        success: true,
                        text: 'Response sent to user',
                        data: { responseId: 'resp-456' }
                    },
                    runId: 'run-complete'
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(3); // thought + action + observation
            expect(trajectory.runId).toBe('run-complete');
            expect(trajectory.totalSteps).toBe(3);

            // Verify proper ordering
            expect(trajectory.steps[0].type).toBe('thought');
            expect(trajectory.steps[1].type).toBe('action');
            expect(trajectory.steps[2].type).toBe('observation');

            // Verify content
            expect(trajectory.steps[0].content).toBe('User needs assistance with their query');
            expect(trajectory.steps[1].content.name).toBe('help-user');
            expect(trajectory.steps[2].content.success).toBe(true);
        });

        it('should sort trajectory steps by timestamp', async () => {
            const mockLogs = [
                {
                    id: 'log-2' as UUID,
                    entityId: mockRuntime.agentId,
                    roomId: testRoomId,
                    type: 'action',
                    createdAt: new Date('2023-10-27T10:00:02Z'), // Later
                    body: { action: 'second-action', runId: 'run-sort' }
                },
                {
                    id: 'log-1' as UUID,
                    entityId: mockRuntime.agentId,
                    roomId: testRoomId,
                    type: 'action',
                    createdAt: new Date('2023-10-27T10:00:01Z'), // Earlier
                    body: { action: 'first-action', runId: 'run-sort' }
                }
            ];

            mockRuntime.getLogs.mockResolvedValueOnce(mockLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(2);
            expect(trajectory.steps[0].content.name).toBe('first-action');
            expect(trajectory.steps[1].content.name).toBe('second-action');
        });
    });

    describe('Convenience Methods', () => {
        it('should provide getLatestTrajectory shortcut', async () => {
            const mockActionLogs = [{
                id: 'log-latest' as UUID,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:00Z'),
                body: {
                    action: 'latest-action',
                    runId: 'run-latest'
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const steps = await reconstructor.getLatestTrajectory(testRoomId);

            expect(steps).toHaveLength(1);
            expect(steps[0].type).toBe('action');
            expect(steps[0].content.name).toBe('latest-action');
        });
    });

    describe('Parameter Extraction', () => {
        it('should extract action parameters from various sources', () => {
            const mockBody = {
                message: 'test input',
                state: { data: { userQuery: 'help me', context: 'testing' } },
                prompts: [{ modelType: 'TEXT_LARGE', prompt: 'Test prompt' }]
            };

            const params = (reconstructor as any).extractActionParameters(mockBody);

            expect(params.input).toBe('test input');
            expect(params.userQuery).toBe('help me');
            expect(params.context).toBe('testing');
            expect(params.prompts).toHaveLength(1);
            expect(params.prompts[0].modelType).toBe('TEXT_LARGE');
        });
    });
});
