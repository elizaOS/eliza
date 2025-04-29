import { logger, type Plugin, type IAgentRuntime } from '@elizaos/core';
import { DegenTradingService } from './tradingService';
import { ServiceTypes } from './types';

export const autofunTraderPlugin: Plugin = {
  name: 'Autofun Trader Plugin',
  description: 'Autonomous trading agent plugin for automated trading strategies',
  evaluators: [],
  providers: [],
  actions: [],
  services: [DegenTradingService],
  init: async (_, runtime: IAgentRuntime) => {
    const worldId = runtime.agentId; // this is global data for the agent

    // first, get all tasks with tags "queue", "repeat", "autofun_trader" and delete them
    const tasks = await runtime.getTasks({
      tags: ['queue', 'repeat', 'autofun_trader'],
    });
    for (const task of tasks) {
      await runtime.deleteTask(task.id);
    }

    runtime.registerTaskWorker({
      name: 'AFTRADER_GENERATE_BUY_SIGNAL',
      validate: async (runtime, _message, _state) => {
        // Check if we have some sentiment data before proceeding
        //const sentimentsData = (await runtime.getCache<Sentiment[]>('sentiments')) || [];
        //if (sentimentsData.length === 0) {
        //return false;
        //}
        return true;
      },
      execute: async (runtime, _options, task) => {
        const tradeService = runtime.getService(ServiceTypes.AUTOFUN_TRADING);
        try {
          tradeService.buyService.generateSignal();
        } catch (error) {
          logger.error('Failed to generate buy signal', error);
          // Log the error but don't delete the task
        }
      },
    });

    runtime.createTask({
      name: 'AFTRADER_GENERATE_BUY_SIGNAL',
      description: 'Generate a buy signal',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 5, // 5 minutes
      },
      tags: ['queue', 'repeat', 'autofun_trader', 'immediate'],
    });

    runtime.registerTaskWorker({
      name: 'AFTRADER_GENERATE_SELL_SIGNAL',
      validate: async (runtime, _message, _state) => {
        // Check if we have some sentiment data before proceeding
        //const sentimentsData = (await runtime.getCache<Sentiment[]>('sentiments')) || [];
        //if (sentimentsData.length === 0) {
        //return false;
        //}
        return true;
      },
      execute: async (runtime, _options, task) => {
        const tradeService = runtime.getService(ServiceTypes.AUTOFUN_TRADING) as unknown; //  as ITradeService
        try {
          tradeService.sellService.generateSignal();
        } catch (error) {
          logger.error('Failed to generate buy signal', error);
          // Log the error but don't delete the task
        }
      },
    });

    runtime.createTask({
      name: 'AFTRADER_GENERATE_SELL_SIGNAL',
      description: 'Generate a sell signal',
      worldId,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 5, // 5 minutes
      },
      tags: ['queue', 'repeat', 'autofun_trader', 'immediate'],
    });
  },
};

export default autofunTraderPlugin;
