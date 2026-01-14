import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentRuntime } from '@elizaos/core';
import { TradingStrategy, TradeOrder, TradeType, OrderType } from '../../../types.ts';
import { AutoTradingManager, TradingConfig } from '../../../services/AutoTradingManager.ts';

describe('AutoTradingManager', () => {
  let manager: AutoTradingManager;
  let mockRuntime: AgentRuntime;
  
  beforeEach(() => {
    mockRuntime = {
      getSetting: vi.fn(),
      getService: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as any;
    
    manager = new AutoTradingManager(mockRuntime);
  });

  describe('initialization', () => {
    it('should start with no active trading', () => {
      const status = manager.getStatus();
      expect(status.isTrading).toBe(false);
      expect(status.strategy).toBeUndefined();
      expect(status.positions).toEqual([]);
    });

    it('should register strategies correctly', () => {
      const mockStrategy: TradingStrategy = {
        id: 'test-strategy',
        name: 'Test Strategy',
        description: 'A test strategy',
        isReady: () => true,
        decide: vi.fn(),
      };
      
      manager.registerStrategy(mockStrategy);
      // We'll need a getStrategy method to test this
      expect(() => manager.startTrading({ strategy: 'test-strategy', tokens: [], maxPositionSize: 1000, intervalMs: 60000 })).not.toThrow();
    });
  });

  describe('trading lifecycle', () => {
    let mockStrategy: TradingStrategy;
    
    beforeEach(() => {
      mockStrategy = {
        id: 'mock-strategy',
        name: 'Mock Strategy',
        description: 'Mock strategy for testing',
        isReady: () => true,
        decide: vi.fn(),
      };
      manager.registerStrategy(mockStrategy);
    });

    it('should start trading with valid config', async () => {
      const config: TradingConfig = {
        strategy: 'mock-strategy',
        tokens: ['SOL'],
        maxPositionSize: 1000,
        intervalMs: 60000,
      };
      
      await manager.startTrading(config);
      
      const status = manager.getStatus();
      expect(status.isTrading).toBe(true);
      expect(status.strategy).toBe('Mock Strategy');
    });

    it('should throw error when starting if already trading', async () => {
      const config: TradingConfig = {
        strategy: 'mock-strategy',
        tokens: ['SOL'],
        maxPositionSize: 1000,
        intervalMs: 60000,
      };
      
      await manager.startTrading(config);
      await expect(manager.startTrading(config)).rejects.toThrow('Already trading');
    });

    it('should throw error for unknown strategy', async () => {
      const config: TradingConfig = {
        strategy: 'unknown-strategy',
        tokens: ['SOL'],
        maxPositionSize: 1000,
        intervalMs: 60000,
      };
      
      await expect(manager.startTrading(config)).rejects.toThrow('Strategy unknown-strategy not found');
    });

    it('should stop trading correctly', async () => {
      const config: TradingConfig = {
        strategy: 'mock-strategy',
        tokens: ['SOL'],
        maxPositionSize: 1000,
        intervalMs: 60000,
      };
      
      await manager.startTrading(config);
      await manager.stopTrading();
      
      const status = manager.getStatus();
      expect(status.isTrading).toBe(false);
      expect(status.strategy).toBeUndefined();
    });
  });

  describe('trade execution', () => {
    beforeEach(async () => {
      const mockStrategy: TradingStrategy = {
        id: 'mock-strategy',
        name: 'Mock Strategy',
        description: 'Mock strategy for testing',
        isReady: () => true,
        decide: vi.fn(),
      };
      manager.registerStrategy(mockStrategy);
      
      await manager.startTrading({
        strategy: 'mock-strategy',
        tokens: ['SOL'],
        maxPositionSize: 1000,
        intervalMs: 60000,
      });
    });

    it('should execute trades when trading is active', async () => {
      const order: TradeOrder = {
        action: TradeType.BUY,
        pair: 'SOL/USDC',
        quantity: 10,
        orderType: OrderType.MARKET,
        timestamp: Date.now(),
        reason: 'Test trade',
      };
      
      const txId = await manager.executeTrade(order);
      expect(txId).toMatch(/^mock_tx_\d+_[a-z0-9]+$/);
    });

    it('should throw error when executing trade while not trading', async () => {
      await manager.stopTrading();
      
      const order: TradeOrder = {
        action: TradeType.BUY,
        pair: 'SOL/USDC',
        quantity: 10,
        orderType: OrderType.MARKET,
        timestamp: Date.now(),
        reason: 'Test trade',
      };
      
      await expect(manager.executeTrade(order)).rejects.toThrow('Not currently trading');
    });
  });

  describe('performance tracking', () => {
    it('should track performance metrics', () => {
      const performance = manager.getPerformance();
      
      expect(performance).toHaveProperty('totalPnL');
      expect(performance).toHaveProperty('dailyPnL');
      expect(performance).toHaveProperty('winRate');
      expect(performance).toHaveProperty('totalTrades');
    });
  });
}); 