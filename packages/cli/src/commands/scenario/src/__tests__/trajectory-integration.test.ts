/**
 * Integration Tests for Trajectory Collection in Scenario Runner (Ticket #5785)
 * 
 * These tests validate end-to-end trajectory capture and integration
 * with the scenario execution system.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { TrajectoryStep, ThoughtStep, ActionStep, ObservationStep } from '@elizaos/core';

describe('Trajectory Integration - Scenario Runner', () => {
    describe('Schema Integration', () => {
        it('should include trajectory field in run result schema', () => {
            // This test will fail until we update the schema
            const { RunResultSchema } = require('../schema');

            const mockRunResult = {
                exitCode: 0,
                stdout: 'Test output',
                stderr: '',
                files: {},
                trajectory: [
                    {
                        type: 'thought',
                        timestamp: '2023-10-27T10:00:01Z',
                        content: 'Processing user request'
                    },
                    {
                        type: 'action',
                        timestamp: '2023-10-27T10:00:02Z',
                        content: {
                            name: 'TEST_ACTION',
                            parameters: { test: true }
                        }
                    },
                    {
                        type: 'observation',
                        timestamp: '2023-10-27T10:00:03Z',
                        content: {
                            success: true,
                            data: { result: 'completed' }
                        }
                    }
                ]
            };

            // Should validate successfully with trajectory field
            expect(() => RunResultSchema.parse(mockRunResult)).not.toThrow();
        });

        it('should make trajectory field optional for backward compatibility', () => {
            // This test will fail until we update the schema
            const { RunResultSchema } = require('../schema');

            const mockRunResultWithoutTrajectory = {
                exitCode: 0,
                stdout: 'Test output',
                stderr: '',
                files: {}
                // No trajectory field
            };

            // Should validate successfully without trajectory field
            expect(() => RunResultSchema.parse(mockRunResultWithoutTrajectory)).not.toThrow();
        });

        it('should validate trajectory step structure', () => {
            // This test will fail until we update the schema
            const { RunResultSchema } = require('../schema');

            const mockRunResultWithInvalidTrajectory = {
                exitCode: 0,
                stdout: 'Test output',
                stderr: '',
                files: {},
                trajectory: [
                    {
                        // Missing required fields
                        type: 'thought'
                        // Missing timestamp and content
                    }
                ]
            };

            // Should fail validation with invalid trajectory structure
            expect(() => RunResultSchema.parse(mockRunResultWithInvalidTrajectory)).toThrow();
        });
    });

    describe('Runtime Integration', () => {
        it('should capture trajectory during scenario execution', async () => {
            // This test will fail until we integrate trajectory capture
            const { createTestRuntime } = require('../runtime-factory');

            // Create a test runtime
            const runtime = await createTestRuntime({
                character: {
                    name: 'TestAgent',
                    bio: 'A test agent for trajectory testing'
                }
            });

            // Mock action for testing
            const mockAction = {
                name: 'TRAJECTORY_TEST_ACTION',
                description: 'Action for trajectory testing',
                validate: () => true,
                handler: mock(async () => ({
                    success: true,
                    data: { test: 'completed' },
                    text: 'Action completed successfully'
                }))
            };

            runtime.registerAction(mockAction);

            // Simulate message processing with trajectory capture
            const mockMessage = {
                id: 'test-message' as any,
                userId: 'test-user' as any,
                agentId: runtime.agentId,
                roomId: 'test-room' as any,
                content: { text: 'Execute test action' },
                createdAt: Date.now(),
            };

            const mockResponse = {
                id: 'test-response' as any,
                userId: runtime.agentId,
                agentId: runtime.agentId,
                roomId: 'test-room' as any,
                content: {
                    text: 'I will execute the test action',
                    thought: 'The user wants me to execute a test action. I should use the trajectory test action.',
                    actions: ['TRAJECTORY_TEST_ACTION']
                },
                createdAt: Date.now(),
            };

            await runtime.processActions(mockMessage, [mockResponse]);

            // Verify trajectory was captured
            const trajectory = runtime.getLatestTrajectory();
            expect(trajectory).toBeDefined();
            expect(trajectory.length).toBeGreaterThan(0);

            // Verify trajectory structure
            const thoughtStep = trajectory.find(step => step.type === 'thought') as ThoughtStep;
            expect(thoughtStep).toBeDefined();
            expect(thoughtStep.content).toContain('trajectory test action');

            const actionStep = trajectory.find(step => step.type === 'action') as ActionStep;
            expect(actionStep).toBeDefined();
            expect(actionStep.content.name).toBe('TRAJECTORY_TEST_ACTION');

            const observationStep = trajectory.find(step => step.type === 'observation') as ObservationStep;
            expect(observationStep).toBeDefined();
            expect(observationStep.content.success).toBe(true);
        });

        it('should include trajectory in scenario run results', async () => {
            // This test will fail until we integrate trajectory collection
            const { runScenario } = require('../runner');

            const mockScenario = {
                name: 'Trajectory Test Scenario',
                description: 'Test scenario for trajectory capture',
                judgment: 'Should capture complete agent trajectory',
                runs: [
                    {
                        name: 'Test Run',
                        input: 'Execute a test action',
                        expected: 'Action should be executed successfully',
                        evaluations: [
                            {
                                type: 'string_contains',
                                expected: 'completed'
                            }
                        ]
                    }
                ]
            };

            // Mock runtime with trajectory support
            const mockRuntime = {
                processActions: mock(async () => { }),
                getLatestTrajectory: mock(() => [
                    {
                        type: 'thought',
                        timestamp: new Date().toISOString(),
                        content: 'Processing test request'
                    },
                    {
                        type: 'action',
                        timestamp: new Date().toISOString(),
                        content: {
                            name: 'TEST_ACTION',
                            parameters: { test: true }
                        }
                    },
                    {
                        type: 'observation',
                        timestamp: new Date().toISOString(),
                        content: {
                            success: true,
                            data: { result: 'completed' }
                        }
                    }
                ])
            };

            const result = await runScenario(mockScenario, mockRuntime);

            // Verify trajectory is included in results
            expect(result.runs[0].trajectory).toBeDefined();
            expect(result.runs[0].trajectory).toHaveLength(3);
            expect(result.runs[0].trajectory[0].type).toBe('thought');
            expect(result.runs[0].trajectory[1].type).toBe('action');
            expect(result.runs[0].trajectory[2].type).toBe('observation');
        });
    });

    describe('Trajectory Data Quality', () => {
        it('should ensure timestamps are properly formatted', async () => {
            // This test will fail until we implement proper timestamp formatting
            const { createTestRuntime } = require('../runtime-factory');

            const runtime = await createTestRuntime({
                character: {
                    name: 'TestAgent',
                    bio: 'Test agent'
                }
            });

            const mockAction = {
                name: 'TIMESTAMP_TEST',
                description: 'Test timestamp formatting',
                validate: () => true,
                handler: mock(async () => ({ success: true }))
            };

            runtime.registerAction(mockAction);

            const mockMessage = {
                id: 'test' as any,
                userId: 'user' as any,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: { text: 'test' },
                createdAt: Date.now(),
            };

            const mockResponse = {
                id: 'response' as any,
                userId: runtime.agentId,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: {
                    text: 'test',
                    thought: 'test thought',
                    actions: ['TIMESTAMP_TEST']
                },
                createdAt: Date.now(),
            };

            await runtime.processActions(mockMessage, [mockResponse]);

            const trajectory = runtime.getLatestTrajectory();

            // All timestamps should be valid ISO strings
            for (const step of trajectory) {
                expect(step.timestamp).toBeDefined();
                expect(() => new Date(step.timestamp)).not.toThrow();
                expect(new Date(step.timestamp).toISOString()).toBe(step.timestamp);
            }
        });

        it('should maintain chronological order of trajectory steps', async () => {
            // This test will fail until we implement proper ordering
            const { createTestRuntime } = require('../runtime-factory');

            const runtime = await createTestRuntime({
                character: {
                    name: 'TestAgent',
                    bio: 'Test agent'
                }
            });

            const mockAction = {
                name: 'ORDER_TEST',
                description: 'Test chronological ordering',
                validate: () => true,
                handler: mock(async () => {
                    // Add small delay to ensure timestamp difference
                    await new Promise(resolve => setTimeout(resolve, 1));
                    return { success: true };
                })
            };

            runtime.registerAction(mockAction);

            const mockMessage = {
                id: 'test' as any,
                userId: 'user' as any,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: { text: 'test' },
                createdAt: Date.now(),
            };

            const mockResponse = {
                id: 'response' as any,
                userId: runtime.agentId,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: {
                    text: 'test',
                    thought: 'test thought',
                    actions: ['ORDER_TEST']
                },
                createdAt: Date.now(),
            };

            await runtime.processActions(mockMessage, [mockResponse]);

            const trajectory = runtime.getLatestTrajectory();

            // Timestamps should be in chronological order
            for (let i = 1; i < trajectory.length; i++) {
                const prevTime = new Date(trajectory[i - 1].timestamp).getTime();
                const currTime = new Date(trajectory[i].timestamp).getTime();
                expect(currTime).toBeGreaterThanOrEqual(prevTime);
            }
        });

        it('should handle complex action parameters correctly', async () => {
            // This test will fail until we implement parameter capture
            const { createTestRuntime } = require('../runtime-factory');

            const runtime = await createTestRuntime({
                character: {
                    name: 'TestAgent',
                    bio: 'Test agent'
                }
            });

            const complexParameters = {
                stringParam: 'test string',
                numberParam: 42,
                booleanParam: true,
                arrayParam: [1, 2, 3],
                objectParam: {
                    nested: {
                        deep: 'value'
                    }
                }
            };

            const mockAction = {
                name: 'COMPLEX_PARAMS_TEST',
                description: 'Test complex parameter capture',
                validate: () => true,
                handler: mock(async (runtime, message, state, options) => {
                    // Parameters should be available in options
                    expect(options).toBeDefined();
                    return { success: true };
                })
            };

            runtime.registerAction(mockAction);

            const mockMessage = {
                id: 'test' as any,
                userId: 'user' as any,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: { text: 'test complex parameters' },
                createdAt: Date.now(),
            };

            const mockResponse = {
                id: 'response' as any,
                userId: runtime.agentId,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: {
                    text: 'testing complex parameters',
                    thought: 'I need to test complex parameter handling',
                    actions: ['COMPLEX_PARAMS_TEST']
                },
                createdAt: Date.now(),
            };

            await runtime.processActions(mockMessage, [mockResponse]);

            const trajectory = runtime.getLatestTrajectory();
            const actionStep = trajectory.find(step => step.type === 'action') as ActionStep;

            expect(actionStep).toBeDefined();
            expect(actionStep.content.name).toBe('COMPLEX_PARAMS_TEST');
            expect(actionStep.content.parameters).toBeDefined();

            // Parameters should be properly serialized and accessible
            expect(typeof actionStep.content.parameters).toBe('object');
        });
    });

    describe('Error Handling', () => {
        it('should handle trajectory capture failures gracefully', async () => {
            // This test will fail until we implement error handling
            const { createTestRuntime } = require('../runtime-factory');

            const runtime = await createTestRuntime({
                character: {
                    name: 'TestAgent',
                    bio: 'Test agent'
                }
            });

            // Mock action that will cause trajectory issues
            const mockAction = {
                name: 'TRAJECTORY_ERROR_TEST',
                description: 'Test trajectory error handling',
                validate: () => true,
                handler: mock(async () => {
                    // This should not break trajectory capture
                    return { success: true };
                })
            };

            runtime.registerAction(mockAction);

            // Even if trajectory capture fails, action execution should continue
            const mockMessage = {
                id: 'test' as any,
                userId: 'user' as any,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: { text: 'test error handling' },
                createdAt: Date.now(),
            };

            const mockResponse = {
                id: 'response' as any,
                userId: runtime.agentId,
                agentId: runtime.agentId,
                roomId: 'room' as any,
                content: {
                    text: 'testing error handling',
                    actions: ['TRAJECTORY_ERROR_TEST']
                },
                createdAt: Date.now(),
            };

            // This should not throw even if trajectory capture fails
            await expect(runtime.processActions(mockMessage, [mockResponse])).resolves.not.toThrow();
        });
    });
});
