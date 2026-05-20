import { describe, expect, it } from 'bun:test';
import { trajectoryLoggerPlugin } from '../index';
import { TrajectoryLoggerService } from '../TrajectoryLoggerService';

describe('trajectory logger plugin contract', () => {
  it('registers the logger as a plugin service', () => {
    expect(trajectoryLoggerPlugin.services).toContain(TrajectoryLoggerService);
    expect(TrajectoryLoggerService.serviceType).toBe('trajectory_logger');
  });

  it('normalizes runtime environment state for step logging', () => {
    const logger = new TrajectoryLoggerService();
    const trajectoryId = logger.startTrajectory('agent-1');

    const stepId = logger.startStep(trajectoryId, {
      timestamp: 123,
      agentBalance: 100,
      agentPnL: 7,
      openPositions: 2,
      unreadMessages: 3,
      extraSignal: 42,
    });

    const trajectory = logger.getActiveTrajectory(trajectoryId);
    const step = trajectory?.steps[0];

    expect(stepId).toBeDefined();
    expect(step?.environmentState.timestamp).toBe(123);
    expect(step?.environmentState.agentPoints).toBe(0);
    expect(step?.environmentState.unreadMessages).toBe(3);
    expect(step?.environmentState.custom).toEqual({ extraSignal: 42 });
  });
});
