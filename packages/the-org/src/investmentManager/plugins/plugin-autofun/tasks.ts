import { type IAgentRuntime, type UUID, logger } from '@elizaos/core';

import Birdeye from './tasks/birdeye';
import BuySignal from './tasks/buy-signal';
import SellSignal from './tasks/sell-signal';
import CoinmarketCap from './tasks/coinmarketcap';
import Twitter from './tasks/twitter';
import TwitterParser from './tasks/twitter-parser';
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
    tags: ['queue', 'repeat', 'autofun'],
  });

  for (const task of tasks) {
    await runtime.deleteTask(task.id);
  }

  runtime.registerTaskWorker({
    name: 'INTEL_BIRDEYE_SYNC_TRENDING',
    validate: async (_runtime, _message, _state) => {
      return true; // TODO: validate after certain time
    },
    execute: async (runtime, _options, task) => {
      const birdeye = new Birdeye(runtime);
      try {
        await birdeye.syncTrendingTokens('solana');
      } catch (error) {
        logger.error('Failed to sync trending tokens', error);
        // kill this task
        runtime.deleteTask(task.id);
      }
    },
  });

  runtime.createTask({
    name: 'INTEL_BIRDEYE_SYNC_TRENDING',
    description: 'Sync trending tokens from Birdeye',
    worldId,
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateInterval: 1000 * 60 * 60, // 1 hour
    },
    tags: ['queue', 'repeat', 'autofun', 'immediate'],
  });

  runtime.registerTaskWorker({
    name: 'INTEL_COINMARKETCAP_SYNC',
    validate: async (_runtime, _message, _state) => {
      return true; // TODO: validate after certain time
    },
    execute: async (runtime, _options, task) => {
      const cmc = new CoinmarketCap(runtime);
      try {
        await cmc.syncTokens();
      } catch (error) {
        logger.debug('Failed to sync tokens', error);
        // kill this task
        await runtime.deleteTask(task.id);
      }
    },
  });

  runtime.createTask({
    name: 'INTEL_COINMARKETCAP_SYNC',
    description: 'Sync tokens from Coinmarketcap',
    worldId,
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateInterval: 1000 * 60 * 5, // 5 minutes
    },
    tags: ['queue', 'repeat', 'autofun', 'immediate'],
  });

  // shouldn't plugin-solana and plugin-evm handle this?
  runtime.registerTaskWorker({
    name: 'INTEL_SYNC_WALLET',
    validate: async (_runtime, _message, _state) => {
      return true; // TODO: validate after certain time
    },
    execute: async (runtime, _options, task) => {
      const birdeye = new Birdeye(runtime);
      try {
        await birdeye.syncWallet();
      } catch (error) {
        logger.error('Failed to sync wallet', error);
        // kill this task
        await runtime.deleteTask(task.id);
      }
    },
  });

  runtime.createTask({
    name: 'INTEL_SYNC_WALLET',
    description: 'Sync wallet from Birdeye',
    worldId,
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateInterval: 1000 * 60 * 5, // 5 minutes
    },
    tags: ['queue', 'repeat', 'autofun', 'immediate'],
  });

  // Only create the Twitter sync task if the Twitter service exists
  const twitterService = runtime.getService('twitter');
  if (twitterService) {
    runtime.registerTaskWorker({
      name: 'INTEL_SYNC_RAW_TWEETS',
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
      name: 'INTEL_SYNC_RAW_TWEETS',
      description: 'Sync raw tweets from Twitter',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 15, // 15 minutes
      },
      tags: ['queue', 'repeat', 'autofun', 'immediate'],
    });

    runtime.registerTaskWorker({
      name: 'INTEL_PARSE_TWEETS',
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
      name: 'INTEL_PARSE_TWEETS',
      description: 'Parse tweets',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 60 * 24, // 24 hours
      },
      tags: ['queue', 'repeat', 'autofun', 'immediate'],
    });
  } else {
    logger.debug(
      'WARNING: Twitter service not found, skipping creation of INTEL_SYNC_RAW_TWEETS task'
    );
  }

  // enable trading stuff only if we need to
  //const tradeService = runtime.getService(ServiceTypes.DEGEN_TRADING) as unknown; //  as ITradeService
  // has to be included after degen-trader
  /*
  const tradeService = runtime.getService('degen_trader') as unknown; //  as ITradeService
  if (tradeService) {
    runtime.registerTaskWorker({
      name: 'INTEL_GENERATE_BUY_SIGNAL',
      validate: async (runtime, _message, _state) => {
        // Check if we have some sentiment data before proceeding
        const sentimentsData = (await runtime.getCache<Sentiment[]>('sentiments')) || [];
        if (sentimentsData.length === 0) {
          return false;
        }
        return true;
      },
      execute: async (runtime, _options, task) => {
        const signal = new BuySignal(runtime);
        try {
          await signal.generateSignal();
        } catch (error) {
          logger.error('Failed to generate buy signal', error);
          // Log the error but don't delete the task
        }
      },
    });

    runtime.createTask({
      name: 'INTEL_GENERATE_BUY_SIGNAL',
      description: 'Generate a buy signal',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 5, // 5 minutes
      },
      tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
    });

    runtime.registerTaskWorker({
      name: 'INTEL_GENERATE_SELL_SIGNAL',
      validate: async (runtime, _message, _state) => {
        // Check if we have some sentiment data before proceeding
        const sentimentsData = (await runtime.getCache<Sentiment[]>('sentiments')) || [];
        if (sentimentsData.length === 0) {
          return false;
        }
        return true;
      },
      execute: async (runtime, _options, task) => {
        const signal = new SellSignal(runtime);
        try {
          await signal.generateSignal();
        } catch (error) {
          logger.error('Failed to generate buy signal', error);
          // Log the error but don't delete the task
        }
      },
    });

    runtime.createTask({
      name: 'INTEL_GENERATE_SELL_SIGNAL',
      description: 'Generate a sell signal',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 5, // 5 minutes
      },
      tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
    });
  } else {
    logger.debug(
      'WARNING: Trader service not found, skipping creation of INTEL_GENERATE_*_SIGNAL task'
    );
  }
  */
};
