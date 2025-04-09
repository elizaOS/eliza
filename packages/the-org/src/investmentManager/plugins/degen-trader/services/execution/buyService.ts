import { type IAgentRuntime, logger, type UUID } from '@elizaos/core';
import { BaseTradeService } from '../base/BaseTradeService';
import { TokenValidationService } from '../validation/TokenValidationService';
import { TradeCalculationService } from '../calculation/tradeCalculation';
import { BuySignalMessage } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { TradeMemoryService } from '../tradeMemoryService';
import { WalletService } from '../walletService';
import { DataService } from '../dataService';
import { AnalyticsService } from '../analyticsService';

export class BuyService extends BaseTradeService {
  private validationService: TokenValidationService;
  private calculationService: TradeCalculationService;
  private tradeMemoryService: TradeMemoryService;

  constructor(
    runtime: IAgentRuntime,
    walletService: WalletService,
    dataService: DataService,
    analyticsService: AnalyticsService,
    tradeMemoryService: TradeMemoryService
  ) {
    super(runtime, walletService, dataService, analyticsService);
    this.validationService = new TokenValidationService(
      runtime,
      walletService,
      dataService,
      analyticsService
    );
    this.calculationService = new TradeCalculationService(
      runtime,
      walletService,
      dataService,
      analyticsService
    );
    this.tradeMemoryService = tradeMemoryService;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing buy service');
    this.runtime.registerEvent('SPARTAN_TRADE_BUY_SIGNAL', this.handleBuySignal.bind(this));
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  private async handleBuySignal(params: any): Promise<void> {
    const TRADER_BUY_KUMA = this.runtime.getSetting('TRADER_BUY_KUMA');
    if (TRADER_BUY_KUMA) {
      fetch(TRADER_BUY_KUMA).catch((e) => {
        logger.error('TRADER_BUY_KUMA err', e);
      });
    }

    const signal: BuySignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_buy_address,
      entityId: 'default',
      tradeAmount: params.buy_amount,
      expectedOutAmount: '0',
    };

    await this.updateExpectedOutAmount(signal);
    this.executeBuy(signal).then((result) => {
      logger.info('executeBuy - result', result);
    });
  }

  private async updateExpectedOutAmount(signal: BuySignalMessage): Promise<void> {
    if (!signal.tradeAmount) return;

    try {
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${
          signal.tokenAddress
        }&amount=${Math.round(Number(signal.tradeAmount) * 1e9)}&slippageBps=0`
      );

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json();
        signal.expectedOutAmount = quoteData.outAmount;
      }
    } catch (error) {
      logger.warn('Failed to get expected out amount for buy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeBuy(signal: BuySignalMessage): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    outAmount?: string;
    swapUsdValue?: string;
  }> {
    try {
      if (!signal) {
        throw new Error('No signal data in buy task');
      }

      const validation = await this.validationService.validateTokenForTrading(signal.tokenAddress);
      if (!validation.isValid) {
        return { success: false, error: validation.reason };
      }

      const marketData = await this.dataService.getTokenMarketData(signal.tokenAddress);

      const walletBalance = await this.walletService.getBalance();
      const buyAmount = await this.calculationService.calculateOptimalBuyAmount({
        tokenAddress: signal.tokenAddress,
        walletBalance,
        signal,
      });

      if (buyAmount <= 0) {
        return { success: false, error: 'Buy amount too small' };
      }

      const slippageBps = await this.calculationService.calculateDynamicSlippage(
        signal.tokenAddress,
        buyAmount,
        false
      );

      const wallet = await this.walletService.getWallet();
      const result = await wallet.buy({
        tokenAddress: signal.tokenAddress,
        amountInSol: buyAmount,
        slippageBps,
      });

      if (result.success) {
        await this.tradeMemoryService.createTrade({
          tokenAddress: signal.tokenAddress,
          chain: 'solana',
          type: 'BUY',
          amount: buyAmount.toString(),
          price: marketData.price.toString(),
          txHash: result.signature,
          metadata: {
            slippage: slippageBps,
            expectedAmount: signal.expectedOutAmount,
            receivedAmount: result.outAmount,
            valueUsd: result.swapUsdValue,
          },
        });

        if (result.outAmount) {
          await this.analyticsService.trackSlippageImpact(
            signal.tokenAddress,
            signal.expectedOutAmount || '0',
            result.outAmount,
            slippageBps,
            false
          );
        }
      }

      return result;
    } catch (error) {
      logger.error('Error executing buy task:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
