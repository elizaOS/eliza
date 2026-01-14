import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPortfolioAction } from '../checkPortfolioAction.ts';
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ServiceType } from '@elizaos/core';

describe('checkPortfolioAction', () => {
  let runtime: IAgentRuntime;
  let message: Memory;
  let state: State;
  let callbackResult: Content | null;
  let callback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    callbackResult = null;

    callback = vi.fn(async (content: Content) => {
      callbackResult = content;
      return [];
    }) as HandlerCallback;

    runtime = {
      agentId: 'test-agent-id',
      getService: vi.fn((serviceName: string | symbol) => {
        if (serviceName === ServiceType.WALLET || serviceName === 'WalletService') {
          return {
            getPortfolio: vi.fn().mockResolvedValue({
              totalValueUsd: 28000,
              assets: [
                {
                  symbol: 'SOL',
                  name: 'Solana',
                  uiAmount: 100,
                  valueUsd: 6000,
                },
                {
                  symbol: 'ETH',
                  name: 'Ethereum',
                  uiAmount: 10,
                  valueUsd: 22000,
                },
              ],
            }),
          };
        }
        return null;
      }) as any,
    } as any;

    message = {
      content: {
        text: 'Show me my portfolio',
      },
    } as Memory;

    state = {} as State;
  });

  describe('metadata', () => {
    it('should have correct action metadata', () => {
      expect(checkPortfolioAction.name).toBe('CHECK_PORTFOLIO');
      expect(checkPortfolioAction.description).toContain('portfolio');
      expect(checkPortfolioAction.examples).toBeDefined();
      expect(checkPortfolioAction.examples?.length).toBeGreaterThan(0);
    });
  });

  describe('validate', () => {
    it('should validate when message contains portfolio keywords', async () => {
      const result = await checkPortfolioAction.validate(runtime, message);
      expect(result).toBe(true);
    });

    it('should validate with different portfolio keywords', async () => {
      const keywords = ['holdings', 'positions', 'balance', 'wallet', 'my'];
      for (const keyword of keywords) {
        message.content.text = `Show ${keyword}`;
        const result = await checkPortfolioAction.validate(runtime, message);
        expect(result).toBe(true);
      }
    });

    it('should not validate when message lacks portfolio keywords', async () => {
      message.content.text = 'Hello, how are you?';
      const result = await checkPortfolioAction.validate(runtime, message);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should display portfolio with multiple positions', async () => {
      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult).toBeDefined();
      expect(callbackResult?.text).toContain('Portfolio Status');
      expect(callbackResult?.text).toContain('Total Value:** $28000.00');
      expect(callbackResult?.text).toContain('SOL');
      expect(callbackResult?.text).toContain('ETH');
      expect(callbackResult?.text).toContain('100.0000');
      expect(callbackResult?.text).toContain('10.0000');
    });

    it('should show empty portfolio message when no assets', async () => {
      runtime.getService = vi.fn().mockReturnValue({
        getPortfolio: vi.fn().mockResolvedValue({
          totalValueUsd: 0,
          assets: [],
        }),
      });

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('Your portfolio is currently empty');
    });

    it('should handle wallet service not available', async () => {
      runtime.getService = vi.fn().mockReturnValue(null);

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('No wallet services are currently available');
    });

    it('should handle wallet service error gracefully', async () => {
      runtime.getService = vi.fn().mockReturnValue({
        getPortfolio: vi.fn().mockRejectedValue(new Error('Wallet error')),
      });

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('Failed to fetch portfolio data');
    });

    it('should filter out zero balance assets', async () => {
      runtime.getService = vi.fn().mockReturnValue({
        getPortfolio: vi.fn().mockResolvedValue({
          totalValueUsd: 10000,
          assets: [
            {
              symbol: 'SOL',
              name: 'Solana',
              uiAmount: 100,
              valueUsd: 10000,
            },
            {
              symbol: 'USDC',
              name: 'USD Coin',
              uiAmount: 0,
              valueUsd: 0,
            },
          ],
        }),
      });

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('SOL');
      expect(callbackResult?.text).not.toContain('USDC');
    });

    it('should handle assets with missing symbols', async () => {
      runtime.getService = vi.fn().mockReturnValue({
        getPortfolio: vi.fn().mockResolvedValue({
          totalValueUsd: 5000,
          assets: [
            {
              name: 'Unknown Token',
              uiAmount: 50,
              valueUsd: 5000,
            },
          ],
        }),
      });

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('Unknown Token');
      expect(callbackResult?.text).toContain('50.0000');
    });

    it('should calculate percentage correctly when total is zero', async () => {
      runtime.getService = vi.fn().mockReturnValue({
        getPortfolio: vi.fn().mockResolvedValue({
          totalValueUsd: 0,
          assets: [
            {
              symbol: 'TEST',
              uiAmount: 100,
              valueUsd: 0,
            },
          ],
        }),
      });

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('0.0%');
    });

    it('should try multiple wallet service names', async () => {
      // All services return null
      runtime.getService = vi.fn().mockReturnValue(null);

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(runtime.getService).toHaveBeenCalledWith(ServiceType.WALLET);
      expect(runtime.getService).toHaveBeenCalledWith('WalletService');
      expect(runtime.getService).toHaveBeenCalledWith('DummyWalletService');
      expect(callbackResult?.text).toContain('No wallet services are currently available');
    });

    it('should format fractional amounts correctly', async () => {
      const mockGetPortfolio = vi.fn().mockResolvedValue({
        totalValueUsd: 1234.56,
        assets: [
          {
            address: 'btc-address',
            symbol: 'BTC',
            uiAmount: 0.12345678,
            valueUsd: 1234.56,
          },
        ],
      });

      runtime.getService = vi.fn((serviceName: string) => {
        if (
          serviceName === ServiceType.WALLET ||
          serviceName === 'WalletService' ||
          serviceName === 'DummyWalletService'
        ) {
          return {
            getPortfolio: mockGetPortfolio,
          };
        }
        return null;
      }) as any;

      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult).toBeDefined();
      // First check if there was an error
      if (callbackResult?.text?.includes('Failed')) {
        console.error('Test failed with error:', callbackResult?.text);
      }
      expect(callbackResult?.text).not.toContain('Failed');
      expect(callbackResult?.text).toContain('0.1235'); // 4 decimal places
      expect(callbackResult?.text).toContain('$1234.56');
    });

    it('should include timestamp in response', async () => {
      await checkPortfolioAction.handler(runtime, message, state, {}, callback);

      expect(callbackResult?.text).toContain('Last updated:');
      expect(callbackResult?.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
