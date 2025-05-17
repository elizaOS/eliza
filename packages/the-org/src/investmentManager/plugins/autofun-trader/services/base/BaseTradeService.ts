import { type IAgentRuntime, logger } from '@elizaos/core';
import { WalletService } from '../walletService';
import { DataService } from '../dataService';
import { AnalyticsService } from '../analyticsService';
import { TradingConfig } from '../../types/trading';
import { DEFAULT_CONFIG } from '../../config/trading';

export abstract class BaseTradeService {
  protected tradingConfig: TradingConfig;

  constructor(
    protected runtime: IAgentRuntime,
    protected walletService: WalletService,
    protected dataService: DataService,
    protected analyticsService: AnalyticsService
  ) {
    this.tradingConfig = DEFAULT_CONFIG;
  }

  public getWalletService() {
    return this.walletService;
  }

  public getDataService() {
    return this.dataService;
  }

  public getAnalyticsService() {
    return this.analyticsService;
  }
}
