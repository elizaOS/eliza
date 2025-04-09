import { type IAgentRuntime, logger, type UUID } from '@elizaos/core';
import { BaseTradeService } from '../base/BaseTradeService';
import { TokenValidationService } from '../validation/TokenValidationService';
import { TradeCalculationService } from '../calculation/tradeCalculation';
import { SellSignalMessage } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { BN, toBN } from '../../utils/bignumber';
import { getTokenBalance } from '../../utils/wallet';
import { TradeMemoryService } from '../tradeMemoryService';
import { WalletService } from '../walletService';
import { DataService } from '../dataService';
import { AnalyticsService } from '../analyticsService';

import { executeTrade } from '../../utils/wallet';

export class SellService extends BaseTradeService {
  private pendingSells: { [tokenAddress: string]: BN } = {};
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
    logger.info('Initializing sell service');
    this.runtime.registerEvent('SPARTAN_TRADE_SELL_SIGNAL', this.handleSellSignal.bind(this));
  }

  async stop(): Promise<void> {
    this.pendingSells = {};
  }

  private async handleSellSignal(params: any): Promise<void> {
    const TRADER_SELL_KUMA = this.runtime.getSetting('TRADER_SELL_KUMA');
    if (TRADER_SELL_KUMA) {
      fetch(TRADER_SELL_KUMA).catch((e) => {
        logger.error('TRADER_SELL_KUMA err', e);
      });
    }

    const signal: SellSignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_sell_address,
      amount: params.sell_amount,
      entityId: 'default',
    };

    await this.updateExpectedOutAmount(signal);
    this.executeSell(signal).then((result) => {
      logger.info('executeSell - result', result);
    });
  }

  private async updateExpectedOutAmount(
    signal: SellSignalMessage & { expectedOutAmount?: string }
  ): Promise<void> {
    if (!signal.amount) return;

    try {
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${
          signal.tokenAddress
        }&outputMint=So11111111111111111111111111111111111111112&amount=${Math.round(
          Number(signal.amount) * 1e9
        )}&slippageBps=0`
      );

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json();
        signal.expectedOutAmount = quoteData.outAmount;
      }
    } catch (error) {
      logger.warn('Failed to get expected out amount for sell', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeSell(signal: SellSignalMessage & { expectedOutAmount?: string }): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    receivedAmount?: string;
    receivedValue?: string;
  }> {
    try {
      if (!signal) {
        throw new Error('No signal data in sell task');
      }

      const tokenBalance = await getTokenBalance(this.runtime, signal.tokenAddress);
      if (!tokenBalance) {
        return { success: false, error: 'No token balance found' };
      }

      const sellAmount = toBN(signal.amount).times(10 ** tokenBalance.decimals);
      if (sellAmount.gt(toBN(tokenBalance.balance))) {
        return {
          success: false,
          error: `Insufficient token balance. Requested: ${sellAmount.toString()}, Available: ${tokenBalance.balance}`,
        };
      }

      try {
        this.pendingSells[signal.tokenAddress] = (
          this.pendingSells[signal.tokenAddress] || toBN(0)
        ).plus(sellAmount);

        const slippageBps = await this.calculationService.calculateDynamicSlippage(
          signal.tokenAddress,
          Number(sellAmount),
          true
        );

        const result = await executeTrade(this.runtime, {
          tokenAddress: signal.tokenAddress,
          amount: sellAmount.toString(),
          slippage: slippageBps,
          dex: 'jup',
          action: 'SELL',
        });

        const marketData = await this.dataService.getTokenMarketData(signal.tokenAddress);

        if (result.success) {
          await this.tradeMemoryService.createTrade({
            tokenAddress: signal.tokenAddress,
            chain: 'solana',
            type: 'SELL',
            amount: sellAmount.toString(),
            price: marketData.price.toString(),
            txHash: result.signature,
            metadata: {
              slippage: slippageBps,
              expectedAmount: signal.expectedOutAmount || '0',
              receivedAmount: result.receivedAmount || '0',
              valueUsd: result.receivedValue || '0',
            },
          });

          await this.analyticsService.trackSlippageImpact(
            signal.tokenAddress,
            signal.expectedOutAmount || '0',
            result.receivedAmount || '0',
            slippageBps,
            true
          );
        }

        return result;
      } finally {
        this.pendingSells[signal.tokenAddress] = (
          this.pendingSells[signal.tokenAddress] || toBN(0)
        ).minus(sellAmount);
        if (this.pendingSells[signal.tokenAddress].lte(toBN(0))) {
          delete this.pendingSells[signal.tokenAddress];
        }
      }
    } catch (error) {
      logger.error('Error executing sell task:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
