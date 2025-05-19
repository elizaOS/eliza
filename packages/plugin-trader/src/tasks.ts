import { type IAgentRuntime, type UUID, logger } from '@elizaos/core';

import Birdeye from './tasks/birdeye';
import BuySignal from './tasks/buy-signal';
import SellSignal from './tasks/sell-signal';
import CoinmarketCap from './tasks/coinmarketcap';
import Twitter from './tasks/tsk_twitter';
import TwitterParser from './tasks/tsk_twitter-parser';
import type { Sentiment } from './types';

// let's not make it a dependency
//import type { ITradeService } from '../../degen-trader/types';

/**
 * Registers tasks for the agent to perform various Intel-related actions.
 * * @param { IAgentRuntime } runtime - The agent runtime object.
 * @param { UUID } [worldId] - The optional world ID to associate with the tasks.
 * @returns {Promise<void>} - A promise that resolves once tasks are registered.
 */
export const registerTasks = async (runtime: IAgentRuntime, worldId?: UUID) => {
  worldId = runtime.agentId; // this is global data for the agent

  // first, get all tasks with tags "queue", "repeat", "degen_intel" and delete them
  const tasks = await runtime.getTasks({
    tags: ['queue', 'repeat', 'plugin_trader'],
  });

  for (const task of tasks) {
    await runtime.deleteTask(task.id);
  }

  // this does talk to the twitter instance
  // I don't see any other plugin using a list of tweets from these users...

  // Only create the Twitter sync task if the Twitter service exists
  const plugins = runtime.plugins.map((p) => p.name);
  //const twitterService = runtime.getService('twitter');
  if (plugins.indexOf('twitter') !== -1) {
    runtime.registerTaskWorker({
      name: 'TRADER_SYNC_RAW_TWEETS',
      validate: async (runtime, _message, _state) => {
        // Check if Twitter service exists and return false if it doesn't
        const twitterService = runtime.getService('twitter');
        if (!twitterService) {
          // Log only once when we'll be removing the task
          logger.debug('Twitter service not available, removing INTEL_SYNC_RAW_TWEETS task');

          // Get all tasks of this type
          const tasks = await runtime.getTasksByName('INTEL_SYNC_RAW_TWEETS');

          // Delete all these tasks
          for (const task of tasks) {
            await runtime.deleteTask(task.id);
          }

          return false;
        }
        return true;
      },
      execute: async (runtime, _options, task) => {
        try {
          const twitter = new Twitter(runtime);
          await twitter.syncRawTweets();
        } catch (error) {
          logger.error('Failed to sync raw tweets', error);
        }
      },
    });

    runtime.createTask({
      name: 'TRADER_SYNC_RAW_TWEETS',
      description: 'Sync raw tweets from Twitter',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 15, // 15 minutes
      },
      tags: ['queue', 'repeat', 'plugin_trader', 'immediate'],
    });

    runtime.registerTaskWorker({
      name: 'TRADER_PARSE_TWEETS',
      validate: async (runtime, _message, _state) => {
        // Check if Twitter service exists and return false if it doesn't
        const twitterService = runtime.getService('twitter');
        if (!twitterService) {
          // The main task handler above will take care of removing all Twitter tasks
          return false; // This will prevent execution
        }
        return true;
      },
      execute: async (runtime, _options, task) => {
        const twitterParser = new TwitterParser(runtime);
        try {
          await twitterParser.parseTweets();
        } catch (error) {
          logger.error('Failed to parse tweets', error);
        }
      },
    });

    runtime.createTask({
      name: 'TRADER_PARSE_TWEETS',
      description: 'Parse tweets',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 60 * 24, // 24 hours
      },
      tags: ['queue', 'repeat', 'plugin_trader', 'immediate'],
    });
  } else {
    console.log(
      'intel:tasks - plugins',
      runtime.plugins.map((p) => p.name)
    );
    logger.debug(
      'WARNING: Twitter plugin not found, skipping creation of INTEL_SYNC_RAW_TWEETS task'
    );
  }
};
