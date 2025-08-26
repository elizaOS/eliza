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
      const mockActionMemories = [
        {
          id: 'mem-1' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397201000, // 2023-10-27T10:00:01Z
          content: {
            type: 'action_result',
            actionName: 'test-action',
            planThought: 'I need to help the user with their request',
            actionResult: {
              success: true,
              text: 'Action completed',
            },
          },
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Should create thought and action steps from memory
      expect(trajectory.steps).toHaveLength(3); // thought + action + observation
      const thoughtStep = trajectory.steps[0];
      const actionStep = trajectory.steps[1];
      const observationStep = trajectory.steps[2];

      expect(thoughtStep.type).toBe('thought');
      expect(thoughtStep.content).toBe('I need to help the user with their request');
      expect(actionStep.type).toBe('action');
      expect(actionStep.content.name).toBe('test-action');
      expect(observationStep.type).toBe('observation');
      expect(observationStep.content).toBe('Action completed');
    });

    it('should reconstruct action steps from action logs', async () => {
      const mockActionMemories = [
        {
          id: 'mem-2' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397202000, // 2023-10-27T10:00:02Z
          content: {
            type: 'action_result',
            actionName: 'send-message',
            actionParams: {
              message: 'Hello world',
              userInput: 'test',
            },
            actionResult: {
              success: true,
              text: 'Message sent',
            },
          },
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      expect(trajectory.steps).toHaveLength(2); // action + observation
      const actionStep = trajectory.steps[0];
      const observationStep = trajectory.steps[1];

      expect(actionStep.type).toBe('action');
      expect(actionStep.content.name).toBe('send-message');
      expect(actionStep.content.parameters.message).toBe('Hello world');
      expect(observationStep.type).toBe('observation');
      expect(observationStep.content).toBe('Message sent');
    });

    it('should reconstruct observation steps from action results', async () => {
      const mockActionMemories = [
        {
          id: 'mem-3' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397203000, // 2023-10-27T10:00:03Z
          content: {
            type: 'action_result',
            actionName: 'send-message',
            actionResult: {
              success: true,
              text: 'Message sent successfully',
              data: { messageId: 'msg-123' },
            },
          },
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      expect(trajectory.steps).toHaveLength(2); // action + observation
      const actionStep = trajectory.steps[0];
      const observationStep = trajectory.steps[1];

      expect(actionStep.type).toBe('action');
      expect(actionStep.content.name).toBe('send-message');
      expect(observationStep.type).toBe('observation');
      expect(observationStep.content).toBe('Message sent successfully');
    });
  });

  describe('Memory-Based Trajectory Reconstruction', () => {
    it('should supplement trajectory from action memories', async () => {
      const mockActionMemories = [
        {
          id: 'mem-1' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397203000, // 2023-10-27T10:00:03Z
          content: {
            type: 'action_result',
            actionName: 'backup-action',
            actionResult: {
              success: true,
              text: 'Backup completed',
            },
          },
        },
      ];

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
      const mockActionMemories = [
        {
          id: 'mem-4' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397201000, // 2023-10-27T10:00:01Z
          content: {
            type: 'action_result',
            actionName: 'process-request',
            planThought: 'I need to process this request',
            actionResult: {
              success: true,
              data: { processed: true },
            },
          },
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      expect(trajectory.steps).toHaveLength(3); // thought + action + observation
      const thoughtStep = trajectory.steps[0];
      const actionStep = trajectory.steps[1];
      const observationStep = trajectory.steps[2];

      expect(thoughtStep.type).toBe('thought');
      expect(thoughtStep.content).toBe('I need to process this request');
      expect(actionStep.type).toBe('action');
      expect(actionStep.content.name).toBe('process-request');
      expect(observationStep.type).toBe('observation');
      expect(observationStep.content).toBe('{"success":true,"data":{"processed":true}}');
    });

    it('should sort trajectory steps by timestamp', async () => {
      const mockActionMemories = [
        {
          id: 'mem-5' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397202000, // 2023-10-27T10:00:02Z (later)
          content: {
            type: 'action_result',
            actionName: 'second-action',
            actionResult: { success: true },
          },
        },
        {
          id: 'mem-6' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397201000, // 2023-10-27T10:00:01Z (earlier)
          content: {
            type: 'action_result',
            actionName: 'first-action',
            actionResult: { success: true },
          },
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

      const steps = await reconstructor.getLatestTrajectory(testRoomId);

      expect(steps).toHaveLength(4); // 2 actions + 2 observations
      expect(steps[0].content.name).toBe('first-action');
      expect(steps[2].content.name).toBe('second-action');
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
        prompts: [{ modelType: 'TEXT_LARGE', prompt: 'Test prompt' }],
      };

      // Test that the reconstructor can handle various parameter structures
      const mockActionMemories = [
        {
          id: 'mem-7' as any,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397201000, // 2023-10-27T10:00:01Z
          content: {
            type: 'action_result',
            actionName: 'test-action',
            actionParams: {
              message: 'test input',
              userQuery: 'help me',
              context: 'testing',
              prompts: [{ modelType: 'TEXT_LARGE', prompt: 'Test prompt' }],
            },
            actionResult: { success: true },
          },
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(mockActionMemories);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      expect(trajectory.steps).toHaveLength(2); // action + observation
      const actionStep = trajectory.steps[0];
      expect(actionStep.type).toBe('action');
      expect(actionStep.content.name).toBe('test-action');
      expect(actionStep.content.parameters.message).toBe('test input');
      expect(actionStep.content.parameters.userQuery).toBe('help me');
    });
  });
});
