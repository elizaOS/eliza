// Combined DegenTradingService that integrates all functionality

import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import { ServiceTypes } from './types';

// Service imports
import { BuyService } from './services/execution/buyService';
import { SellService } from './services/execution/sellService';
import { DataService } from './services/dataService';
import { AnalyticsService } from './services/analyticsService';
import { MonitoringService } from './services/monitoringService';
import { TaskService } from './services/taskService';
import { WalletService } from './services/walletService';
import { TradeExecutionService } from './services/execution/tradeExecutionService';
import { TradeMemoryService } from './services/tradeMemoryService';

interface TokenSignal {
  address: string;
  symbol: string;
  marketCap: number;
  volume24h: number;
  price: number;
  liquidity: number;
  score: number;
  reasons: string[];
  technicalSignals?: {
    rsi: number;
    macd: {
      value: number;
      signal: number;
      histogram: number;
    };
    volumeProfile: {
      trend: 'increasing' | 'decreasing' | 'stable';
      unusualActivity: boolean;
    };
    volatility: number;
  };
  socialMetrics?: {
    mentionCount: number;
    sentiment: number;
    influencerMentions: number;
  };
  cmcMetrics?: {
    rank: number;
    priceChange24h: number;
    volumeChange24h: number;
  };
}

interface RiskLimits {
  maxPositionSize: number;
  maxDrawdown: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}

interface TradingConfig {
  intervals: {
    priceCheck: number;
    walletSync: number;
    performanceMonitor: number;
  };
  thresholds: {
    minLiquidity: number;
    minVolume: number;
    minScore: number;
  };
  riskLimits: RiskLimits;
  slippageSettings: {
    baseSlippage: number; // Base slippage in percentage (e.g., 0.5 for 0.5%)
    maxSlippage: number; // Maximum slippage allowed in percentage
    liquidityMultiplier: number; // Multiplier for liquidity-based adjustment
    volumeMultiplier: number; // Multiplier for volume-based adjustment
  };
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  expiry: number;
}

export class DegenTradingService extends Service {
  private isRunning = false;
  private processId: string;

  // Service instances
  public buyService: BuyService;
  public sellService: SellService;
  private dataService: DataService;
  private analyticsService: AnalyticsService;
  private monitoringService: MonitoringService;
  private taskService: TaskService;
  private walletService: WalletService;
  private tradeExecutionService: TradeExecutionService;
  private tradeMemoryService: TradeMemoryService;

  static serviceType = ServiceTypes.AUTOFUN_TRADING;
  capabilityDescription = 'The agent is able to trade on the Solana blockchain';

  constructor(public runtime: IAgentRuntime) {
    super(runtime);
    this.processId = `sol-process-${Date.now()}`;

    // Initialize services
    this.walletService = new WalletService(runtime);
    this.dataService = new DataService(runtime, this.walletService);
    this.analyticsService = new AnalyticsService(runtime);
    this.tradeMemoryService = new TradeMemoryService(
      runtime,
      this.walletService,
      this.dataService,
      this.analyticsService
    );
    this.tradeExecutionService = new TradeExecutionService(
      runtime,
      this.walletService,
      this.dataService,
      this.analyticsService
    );
    this.buyService = new BuyService(
      runtime,
      this.walletService,
      this.dataService,
      this.analyticsService,
      this.tradeMemoryService
    );
    this.sellService = new SellService(
      runtime,
      this.walletService,
      this.dataService,
      this.analyticsService,
      this.tradeMemoryService
    );
    this.taskService = new TaskService(runtime, this.buyService, this.sellService);
    this.monitoringService = new MonitoringService(
      runtime,
      this.dataService,
      this.walletService,
      this.analyticsService
    );
  }

  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    const service = new DegenTradingService(runtime);
    service.start();
    return service;
  }
  /**
   * Stops the Scenario service associated with the given runtime.
   *
   * @param {IAgentRuntime} runtime The runtime to stop the service for.
   * @throws {Error} When the Scenario service is not found.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(DegenTradingService.serviceType);
    if (!service) {
      throw new Error('DegenTradingService service not found');
    }
    service.stop();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading service is already running');
      return;
    }

    try {
      logger.info('Starting trading service...');

      // Initialize all services
      await Promise.all([
        this.dataService.initialize(),
        this.analyticsService.initialize(),
        this.walletService.initialize(),
        this.tradeMemoryService.initialize(),
        this.buyService.initialize(),
        this.sellService.initialize(),
        this.monitoringService.initialize(),
      ]);

      // Register tasks after services are initialized
      await this.taskService.registerTasks();

      this.isRunning = true;
      logger.info('Trading service started successfully');
    } catch (error) {
      logger.error('Error starting trading service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Trading service is not running');
      return;
    }

    try {
      logger.info('Stopping trading service...');

      // Stop all services
      await Promise.all([
        this.dataService.stop(),
        this.analyticsService.stop(),
        this.walletService.stop(),
        this.buyService.stop(),
        this.sellService.stop(),
        this.monitoringService.stop(),
      ]);

      this.isRunning = false;
      logger.info('Trading service stopped successfully');
    } catch (error) {
      logger.error('Error stopping trading service:', error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}
