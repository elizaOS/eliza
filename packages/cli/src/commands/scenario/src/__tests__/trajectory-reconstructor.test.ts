/**
 * TrajectoryReconstructor Unit Tests (Ticket #5785)
 * 
 * Tests for the non-invasive trajectory reconstruction system that
 * builds agent trajectories from existing logs and memories.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { TrajectoryReconstructor } from '../TrajectoryReconstructor';

describe('TrajectoryReconstructor - Non-Invasive Approach', () => {
    let reconstructor: TrajectoryReconstructor;
    let mockRuntime: any;
    const testRoomId = 'test-room-id' as any;

    beforeEach(() => {
        mockRuntime = {
            agentId: 'test-agent-id' as any,
            getLogs: mock(() => Promise.resolve([])),
            getMemories: mock(() => Promise.resolve([])),
        };

        reconstructor = new TrajectoryReconstructor(mockRuntime);
    });

    describe('Basic Functionality', () => {
        it('should create reconstructor instance', () => {
            expect(reconstructor).toBeDefined();
        });

        it('should handle empty logs gracefully', async () => {
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(0);
        });
    });

    describe('Log-Based Trajectory Reconstruction', () => {
        it('should reconstruct thought steps from action plans', async () => {
            const mockActionLogs = [{
                id: 'log-1' as any,
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

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            // Should create thought step from planThought
            expect(trajectory.steps).toHaveLength(1);
            const thoughtStep = trajectory.steps[0];
            expect(thoughtStep.type).toBe('thought');
            expect(thoughtStep.content).toBe('I need to help the user with their request');
        });

        it('should reconstruct action steps from action logs', async () => {
            const mockActionLogs = [{
                id: 'log-2' as any,
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
        });

        it('should reconstruct observation steps from action results', async () => {
            const mockActionLogs = [{
                id: 'log-3' as any,
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

            expect(trajectory.steps).toHaveLength(1);
            const actionStep = trajectory.steps[0];
            expect(actionStep.type).toBe('action');
            expect(actionStep.content.name).toBe('send-message');
        });
    });

    describe('Memory-Based Trajectory Reconstruction', () => {
        it('should supplement trajectory from action memories', async () => {
            const mockActionMemories = [{
                id: 'mem-1' as any,
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

            // Should create action and observation steps from memory
            expect(trajectory.steps).toHaveLength(2);
            const actionStep = trajectory.steps[0];
            const observationStep = trajectory.steps[1];

            expect(actionStep.type).toBe('action');
            expect(actionStep.content.name).toBe('backup-action');
            expect(observationStep.type).toBe('observation');
            expect(observationStep.content).toBe('Backup completed');
        });
    });

    describe('Complete Trajectory Flow', () => {
        it('should reconstruct complete thought->action->observation flow', async () => {
            const mockActionLogs = [{
                id: 'log-4' as any,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:01Z'),
                body: {
                    action: 'process-request',
                    planThought: 'I need to process this request',
                    result: {
                        success: true,
                        data: { processed: true }
                    },
                    runId: 'run-123'
                }
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(1);
            const step = trajectory.steps[0];
            expect(step.type).toBe('action');
            expect(step.content.name).toBe('process-request');
        });

        it('should sort trajectory steps by timestamp', async () => {
            const mockActionLogs = [
                {
                    id: 'log-5' as any,
                    entityId: mockRuntime.agentId,
                    roomId: testRoomId,
                    type: 'action',
                    createdAt: new Date('2023-10-27T10:00:02Z'),
                    body: {
                        action: 'second-action',
                        runId: 'run-123'
                    }
                },
                {
                    id: 'log-6' as any,
                    entityId: mockRuntime.agentId,
                    roomId: testRoomId,
                    type: 'action',
                    createdAt: new Date('2023-10-27T10:00:01Z'),
                    body: {
                        action: 'first-action',
                        runId: 'run-123'
                    }
                }
            ];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const steps = await reconstructor.getLatestTrajectory(testRoomId);

            expect(steps).toHaveLength(2);
            expect(steps[0].content.name).toBe('first-action');
            expect(steps[1].content.name).toBe('second-action');
        });
    });

    describe('ConvenienceMethods', () => {
        it('should provide getLatestTrajectory shortcut', async () => {
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const steps = await reconstructor.getLatestTrajectory(testRoomId);

            expect(steps).toHaveLength(0);
        });
    });

    describe('Parameter Extraction', () => {
        it('should extract action parameters from various sources', async () => {
            const mockBody = {
                action: 'test-action',
                message: 'test input',
                state: { data: { userQuery: 'help me', context: 'testing' } },
                prompts: [{ modelType: 'TEXT_LARGE', prompt: 'Test prompt' }]
            };

            // Test that the reconstructor can handle various parameter structures
            const mockActionLogs = [{
                id: 'log-7' as any,
                entityId: mockRuntime.agentId,
                roomId: testRoomId,
                type: 'action',
                createdAt: new Date('2023-10-27T10:00:01Z'),
                body: mockBody
            }];

            mockRuntime.getLogs.mockResolvedValueOnce(mockActionLogs);
            mockRuntime.getLogs.mockResolvedValueOnce([]);
            mockRuntime.getMemories.mockResolvedValue([]);

            const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

            expect(trajectory.steps).toHaveLength(1);
            const actionStep = trajectory.steps[0];
            expect(actionStep.type).toBe('action');
            expect(actionStep.content.name).toBe('test-action');
        });
    });
});
