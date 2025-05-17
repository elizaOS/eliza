import { type IAgentRuntime, ModelType, logger, parseJSONObjectFromText } from '@elizaos/core';
import type { Sentiment } from '../schemas';
import type { IToken } from '../types';

export function setupSentimentGenerator(runtime) {
  worldId = runtime.agentId; // this is global data for the agent

  // first, get all tasks with tags "queue", "repeat", "degen_intel" and delete them
  const tasks = await runtime.getTasks({
    tags: ['queue', 'repeat', 'plugin_trader'],
  });

  for (const task of tasks) {
    await runtime.deleteTask(task.id);
  }

  // shouldn't plugin-solana and plugin-evm handle this?
  runtime.registerTaskWorker({
    name: 'TRADER_SYNC_SENTIMENT',
    validate: async (_runtime, _message, _state) => {
      return true; // TODO: validate after certain time
    },
    execute: async (runtime, _options, task) => {
      try {
        // do the thing
        console.log('PLUGIN_TRADER_SENTIMENT');
        runtime.emitEvent('PLUGIN_TRADER_SENTIMENT', {});
      } catch (error) {
        logger.error('Failed to sync sentiment', error);
        // kill this task
        //await runtime.deleteTask(task.id);
      }
    },
  });

  runtime.createTask({
    name: 'TRADER_SYNC_SENTIMENT',
    description: 'calculate sentiment',
    worldId,
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateInterval: 1000 * 60 * 5, // 5 minutes
    },
    tags: ['queue', 'repeat', 'plugin_trader', 'immediate'],
  });
}
