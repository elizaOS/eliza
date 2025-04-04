import { type IAgentRuntime, type UUID, logger } from '@elizaos/core';
import { TeamUpdateTrackerService } from './services/TeamUpdateTrackerService';

export const registerTasks = async (runtime: IAgentRuntime, worldId?: UUID) => {
  worldId = runtime.agentId;

  // Clear existing tasks
  const tasks = await runtime.getTasks({
    tags: ['queue', 'repeat', 'team_coordinator'],
  });

  for (const task of tasks) {
    await runtime.deleteTask(task.id);
  }

  // Register the check-in service task worker
  runtime.registerTaskWorker({
    name: 'TEAM_CHECK_IN_SERVICE',
    validate: async (_runtime, _message, _state) => {
      return true;
    },
    execute: async (runtime, _options, task) => {
      try {
        const teamUpdateService = new TeamUpdateTrackerService(runtime);
        logger.info('Running team check-in service job');
        await teamUpdateService.checkInServiceJob();
      } catch (error) {
        logger.error('Failed to run check-in service job:', error);
      }
    },
  });

  // Create the periodic task
  runtime.createTask({
    name: 'TEAM_CHECK_IN_SERVICE',
    description: 'Regular team check-in service job',
    worldId,
    metadata: {
      updatedAt: Date.now(),
      updateInterval: 1000 * 60 * 5, // 5 minutes
    },
    tags: ['queue', 'repeat', 'team_coordinator'],
  });
};
