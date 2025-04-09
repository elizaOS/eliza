import { type AgentRuntime as IAgentRuntime, logger } from '@elizaos/core';
import { BuyService } from './execution/buyService';
import { SellService } from './execution/sellService';
import { v4 as uuidv4 } from 'uuid';
import { ServiceTypes } from '../types';
import { TradeExecutionService } from './execution/tradeExecutionService';
import { type SellSignalMessage } from '../types';
import type { AgentRuntime } from '@elizaos/core';

export class TaskService extends TradeExecutionService {
  private scheduledTasks: NodeJS.Timeout[] = [];

  constructor(
    protected override runtime: AgentRuntime,
    private buyService: BuyService,
    private sellService: SellService
  ) {
    // Get protected services from buyService via public methods
    super(
      runtime,
      buyService.getWalletService(),
      buyService.getDataService(),
      buyService.getAnalyticsService()
    );
  }

  async registerTasks(): Promise<void> {
    this.registerSellTasks();
  }

  async stop(): Promise<void> {
    // Clear all scheduled tasks
    this.scheduledTasks.forEach((task) => clearTimeout(task));
    this.scheduledTasks = [];
  }

  private registerSellTasks(): void {
    this.runtime.registerTaskWorker({
      name: 'EXECUTE_SELL',
      execute: async (_runtime: typeof IAgentRuntime, options: any) => {
        logger.info('Executing sell task');
        return await this.executeSellTask(options);
      },
      validate: async () => true,
    });
  }

  async createSellTask(signal: SellSignalMessage) {
    try {
      logger.info('Creating sell task', {
        tokenAddress: signal.tokenAddress,
        amount: signal.amount,
        currentBalance: signal.currentBalance,
      });

      // Fetch expected receive amount (USDC) for this sell
      let expectedReceiveAmount = '0';
      try {
        // Get a quote for the expected amount we'll receive in USDC
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${signal.tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${Math.round(Number(signal.amount) * 1e9)}&slippageBps=0`;
        const quoteResponse = await fetch(quoteUrl);
        const quoteData = await quoteResponse.json();

        if (quoteData?.outAmount) {
          expectedReceiveAmount = quoteData.outAmount;
          logger.info('Expected receive amount for sell', {
            expectedReceiveAmount,
            tokenAddress: signal.tokenAddress,
          });
        }
      } catch (error) {
        console.log('Failed to fetch expected receive amount for sell', error);
      }

      // Calculate slippage using parent class method
      const slippage = await this.calculateExpectedAmount(
        signal.tokenAddress,
        Number(signal.amount),
        true
      );

      const taskId = uuidv4();
      await this.runtime.databaseAdapter.createTask({
        id: taskId,
        name: 'EXECUTE_SELL',
        description: `Execute sell for ${signal.tokenAddress}`,
        tags: ['queue', 'repeat', ServiceTypes.DEGEN_TRADING],
        metadata: {
          signal,
          expectedReceiveAmount,
          slippageBps: Number(slippage),
        },
      });

      logger.info('Sell task created', { taskId });
      return { success: true, taskId };
    } catch (error) {
      console.log('Error creating sell task', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeSellTask(options: any) {
    try {
      const { signal } = options;
      if (!signal) {
        throw new Error('No signal data in sell task');
      }

      const result = await this.sellService.handleSellSignal(signal);

      if (result.success) {
        logger.info('Sell task executed successfully', {
          signature: result.signature,
          receivedAmount: result.receivedAmount,
        });
      } else {
        logger.error('Sell task failed', { error: result.error });
      }

      return result;
    } catch (error) {
      console.log('Error executing sell task:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
