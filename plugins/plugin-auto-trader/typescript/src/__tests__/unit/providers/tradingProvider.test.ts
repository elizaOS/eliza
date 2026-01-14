import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tradingProvider } from '../../../providers/tradingProvider.ts';
import { AutoTradingManager } from '../../../services/AutoTradingManager.ts';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

describe('tradingProvider', () => {
  let mockRuntime: IAgentRuntime;
  let mockManager: AutoTradingManager;
  let mockMemory: Memory;
  let mockState: State;

  beforeEach(() => {
    // Create mock manager
    mockManager = {
      getStatus: vi.fn().mockReturnValue({
        isTrading: true,
        strategy: 'Test Strategy',
        positions: [
          {
            tokenAddress: 'SOL',
            amount: 10,
            entryPrice: 100,
            currentPrice: 110,
          },
          {
            tokenAddress: 'BONK',
            amount: 1000000,
            entryPrice: 0.00001,
            currentPrice: 0.000012,
          },
        ],
        performance: {
          totalPnL: 150,
          dailyPnL: 50,
          winRate: 0.65,
          totalTrades: 20,
        },
      }),
    } as any;

    // Create mock runtime
    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockManager),
      getSetting: vi.fn(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as any;

    mockMemory = { content: { text: 'test' } } as any;
    mockState = {} as any;
  });

  it('should return comprehensive trading dashboard when services are available', async () => {
    const result = await tradingProvider.get(mockRuntime, mockMemory, mockState);
    
    expect(result.text).toContain('Trading Dashboard');
    expect(result.text).toContain('ACTIVE 🟢');
    expect(result.text).toContain('Test Strategy');
    expect(result.text).toContain('Total P&L:');
    expect(result.text).toContain('Win Rate: 65.0%');
    expect(result.text).toContain('Total Trades: 20');
    expect(result.text).toContain('Open Positions: 2');
  });

  it('should show correct position details', async () => {
    const result = await tradingProvider.get(mockRuntime, mockMemory, mockState);
    
    // Check SOL position
    expect(result.text).toContain('SOL: 10.0000 @ $100.0000 (10.00% | +$100.00)');
    
    // Check BONK position
    expect(result.text).toContain('BONK: 1000000.0000 @ $0.0000 (20.00% | +$2.00)');
  });

  it('should calculate total P&L including unrealized', async () => {
    const result = await tradingProvider.get(mockRuntime, mockMemory, mockState);
    
    // Total P&L should be realized (150) + unrealized (100 + 2) = 252
    expect(result.text).toMatch(/Total P&L: \+\$252\.00/);
    expect(result.text).toContain('Unrealized P&L: +$102.00');
  });

  it('should show stopped status when not trading', async () => {
    mockManager.getStatus = vi.fn().mockReturnValue({
      isTrading: false,
      strategy: undefined,
      positions: [],
      performance: {
        totalPnL: 0,
        dailyPnL: 0,
        winRate: 0,
        totalTrades: 0,
      },
    });

    const result = await tradingProvider.get(mockRuntime, mockMemory, mockState);
    
    expect(result.text).toContain('STOPPED 🔴');
    expect(result.text).toContain('Use "start trading" to begin automated trading');
  });

  it('should handle missing trading manager gracefully', async () => {
    mockRuntime.getService = vi.fn().mockReturnValue(null);
    
    const result = await tradingProvider.get(mockRuntime, mockMemory, mockState);
    
    expect(result.text).toBe('Trading services not available');
  });

  it('should handle errors gracefully', async () => {
    mockRuntime.getService = vi.fn().mockImplementation(() => {
      throw new Error('Service error');
    });
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    const result = await tradingProvider.get(mockRuntime, mockMemory, mockState);
    
    expect(result.text).toBe('Unable to fetch trading information');
    expect(consoleSpy).toHaveBeenCalledWith('Error in tradingProvider:', expect.any(Error));
    
    consoleSpy.mockRestore();
  });
}); 