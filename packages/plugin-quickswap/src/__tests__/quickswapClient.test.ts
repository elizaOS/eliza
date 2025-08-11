import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { IAgentRuntime } from '@elizaos/core';
import { JsonRpcProvider, Wallet, Contract, parseUnits } from 'ethers';
import {
  ChainId,
  Fetcher,
  CurrencyAmount,
  Trade,
  Percent,
  Router,
  TokenAmount,
  Pair,
} from 'quickswap-sdk';

// Mock external dependencies
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    JsonRpcProvider: vi.fn(() => ({
      getNetwork: vi.fn(() => Promise.resolve({ chainId: 137 })),
      getTransactionReceipt: vi.fn((hash) => {
        if (hash === '0xSuccessTxHash') {
          return Promise.resolve({
            status: 1,
            blockNumber: 123,
            gasUsed: BigInt('21000'),
            from: '0xFrom',
            to: '0xTo',
            hash: '0xSuccessTxHash',
          });
        } else if (hash === '0xPendingTxHash') {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      }),
      getTransaction: vi.fn((hash) => {
        if (hash === '0xPendingTxHash') {
          return Promise.resolve({
            from: '0xFrom',
            to: '0xTo',
            value: BigInt('100'),
            hash: '0xPendingTxHash',
          });
        }
        return Promise.resolve(null);
      }),
    })),
    Wallet: vi.fn(() => ({
      address: '0xmockWalletAddress',
      sendTransaction: vi.fn(() =>
        Promise.resolve({
          hash: '0xmockTransactionHash',
          wait: vi.fn(() =>
            Promise.resolve({
              status: 1,
              blockNumber: 123,
              gasUsed: BigInt('21000'),
              from: '0xFrom',
              to: '0xTo',
              hash: '0xmockTransactionHash',
            })
          ),
        })
      ),
    })),
    Contract: vi.fn((address, abi, signerOrProvider) => {
      const mockContract = {
        decimals: vi.fn(() => Promise.resolve(18)),
        symbol: vi.fn(() => Promise.resolve('MOCK')),
        totalSupply: vi.fn(() => Promise.resolve(BigInt('1000000000000000000000'))),
        // Generic handler for any method dynamically called on the contract
        // It should return a transaction object with a .wait() method
        executeTransaction: vi.fn(() =>
          Promise.resolve({
            hash: '0xmockTransactionHash',
            wait: vi.fn(() =>
              Promise.resolve({
                status: 1,
                blockNumber: 123,
                gasUsed: BigInt('21000'),
                from: '0xFrom',
                to: '0xTo',
                hash: '0xmockTransactionHash',
              })
            ),
          })
        ),
      };

      // Use a Proxy to dynamically handle method access,
      // returning `executeTransaction` for any method not explicitly mocked
      return new Proxy(mockContract, {
        get: (target, prop, receiver) => {
          if (typeof prop === 'string' && prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          // If the property is a method name (string) and not already mocked,
          // return the generic executeTransaction mock.
          // This covers method calls like `routerContract.swapExactTokensForTokens(...args)`
          if (typeof target.executeTransaction === 'function') {
            return target.executeTransaction;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }),
    parseUnits: vi.fn((amount, decimals) =>
      BigInt(Math.floor(parseFloat(amount) * 10 ** decimals).toString())
    ),
    Interface: vi.fn(() => ({
      encodeFunctionData: vi.fn(() => '0xmockEncodedFunctionData'),
    })),
  };
});

vi.mock('quickswap-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('quickswap-sdk')>();

  // A simplified mock for Token to avoid internal sdk validation issues
  // This mock should contain all properties and methods that quickswapClient.ts attempts to access
  const mockToken = (
    chainId: ChainId,
    address: string,
    decimals: number,
    symbol: string,
    name: string
  ) => ({
    chainId: chainId,
    address: address,
    decimals: decimals,
    symbol: symbol,
    name: name,
    // Add any other properties/methods accessed by quickswapClient.ts if needed
    equals: vi.fn((other: any) => other.address.toLowerCase() === address.toLowerCase()),
    sortsBefore: vi.fn(() => false),
    isNative: false,
    isToken: true,
    serialize: vi.fn(() => ({
      chainId: chainId,
      address: address,
      decimals: decimals,
      symbol: symbol,
      name: name,
      success: true,
    })),
    get wrapped() {
      return this; // For WETH.wrapped
    },
  });

  // Mock CurrencyAmount to prevent BigInt serialization issues when logging
  const MockCurrencyAmount = vi.fn((token, rawAmount) => {
    return {
      token,
      raw: rawAmount,
      toExact: vi.fn(() => (Number(rawAmount) / 10 ** token.decimals).toString()),
      toSignificant: vi.fn((significantDigits?: number) =>
        (Number(rawAmount) / 10 ** token.decimals).toFixed(significantDigits || 6)
      ),
      wrapped: vi.fn(() => MockCurrencyAmount(token.wrapped, rawAmount)),
    };
  }) as any;

  // Mock TokenAmount, similar to CurrencyAmount for consistent BigInt handling
  const MockTokenAmount = vi.fn((token, rawAmount) => {
    return {
      token,
      raw: rawAmount,
      toExact: vi.fn(() => (Number(rawAmount) / 10 ** token.decimals).toString()),
      toSignificant: vi.fn((significantDigits?: number) =>
        (Number(rawAmount) / 10 ** token.decimals).toFixed(significantDigits || 6)
      ),
    };
  }) as any;

  return {
    ...actual,
    Token: vi.fn((chainId, address, decimals, symbol, name) =>
      mockToken(chainId, address, decimals, symbol, name)
    ) as any, // Mock Token constructor
    WETH: {
      [actual.ChainId.MATIC]: mockToken(
        actual.ChainId.MATIC,
        '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
        18,
        'WMATIC',
        'Wrapped MATIC'
      ),
    },
    Fetcher: {
      fetchTokenData: vi.fn((chainId, address, provider) => {
        // Mock specific hardcoded tokens in quickswapClient.ts first
        const lowerCaseAddress = address.toLowerCase();
        if (lowerCaseAddress === '0x2791b072600277340f1ada76ae19a6c09bed2737') {
          // USDC
          return Promise.resolve(
            mockToken(chainId, '0x2791B072600277340f1aDa76aE19A6C09bED2737', 6, 'USDC', 'USD Coin')
          );
        } else if (lowerCaseAddress === '0x8f3cf7ad23cd3cadbd9735fd5cbf25ab28cef580') {
          // DAI
          return Promise.resolve(
            mockToken(
              chainId,
              '0x8f3Cf7ad23Cd3CaDbD9735Fd5CbF25ab28cef580',
              18,
              'DAI',
              'Dai Stablecoin'
            )
          );
        } else if (lowerCaseAddress === '0x831753dd7087dfc61') {
          // QUICK
          return Promise.resolve(
            mockToken(chainId, '0x831753DD7087DfC61', 18, 'QUICK', 'Quickswap')
          );
        }
        // For 0xMockTokenAddress, it should resolve successfully
        if (lowerCaseAddress === '0xmocktokenaddress') {
          return Promise.resolve(
            mockToken(chainId, address, 18, 'GENERIC_MOCK', 'Generic Mock Token')
          );
        }
        return Promise.reject(new Error('Token not found in mock Fetcher.fetchTokenData'));
      }),
      fetchPairData: vi.fn((tokenA, tokenB, provider) => {
        const mockWmatic = mockToken(
          actual.ChainId.MATIC,
          '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
          18,
          'WMATIC',
          'Wrapped MATIC'
        );
        const mockUsdc = mockToken(
          actual.ChainId.MATIC,
          '0x2791B072600277340f1aDa76aE19A6C09bED2737',
          6,
          'USDC',
          'USD Coin'
        );

        if (
          (tokenA.symbol === 'WMATIC' && tokenB.symbol === 'USDC') ||
          (tokenA.symbol === 'USDC' && tokenB.symbol === 'WMATIC')
        ) {
          const mockPair = {
            token0: mockWmatic,
            token1: mockUsdc,
            reserve0: new MockCurrencyAmount(mockWmatic, BigInt('1000000000000000000')), // 1 WMATIC
            reserve1: new MockCurrencyAmount(mockUsdc, BigInt('2000000')), // 2 USDC (6 decimals)
            getLiquidityMinted: vi.fn((pair, tokenAAmount, tokenBAmount) => {
              return new MockTokenAmount(
                mockToken(ChainId.MATIC, '0xLPTokenAddress', 18, 'UNI-V2', 'Uniswap V2'),
                BigInt('1000000000000000000')
              );
            }),
            getLiquidityValue: vi.fn((token, totalSupply, liquidity, fraction) => {
              return new MockCurrencyAmount(token, BigInt(1)); // Simplified mock
            }),
            involvesToken: vi.fn((token) => {
              return token.equals(mockWmatic) || token.equals(mockUsdc);
            }),
            token0Price: {
              toSignificant: vi.fn(() => '2.0'),
            },
            token1Price: {
              toSignificant: vi.fn(() => '0.5'),
            },
            reserveOf: vi.fn((token) => {
              if (token.equals(mockWmatic)) {
                return mockPair.reserve0;
              } else if (token.equals(mockUsdc)) {
                return mockPair.reserve1;
              }
              throw new Error('Token not in pair');
            }),
            liquidityToken: mockToken(
              ChainId.MATIC,
              '0xLPTokenAddress',
              18,
              'UNI-V2',
              'Uniswap V2'
            ),
          };
          return Promise.resolve(mockPair as Pair);
        }
        return Promise.reject(new Error('Pair not found in mock Fetcher.fetchPairData'));
      }),
    },
    Trade: {
      bestTradeExactIn: vi.fn(() => [
        {
          inputAmount: new MockCurrencyAmount(
            mockToken(
              actual.ChainId.MATIC,
              '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
              18,
              'WMATIC',
              'Wrapped MATIC'
            ),
            BigInt('1000000000000000000')
          ),
          outputAmount: new MockCurrencyAmount(
            mockToken(
              actual.ChainId.MATIC,
              '0x2791B072600277340f1aDa76aE19A6C09bED2737',
              6,
              'USDC',
              'USD Coin'
            ),
            BigInt('2000000')
          ),
          route: {
            path: [
              mockToken(
                actual.ChainId.MATIC,
                '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
                18,
                'WMATIC',
                'Wrapped MATIC'
              ),
              mockToken(
                actual.ChainId.MATIC,
                '0x2791B072600277340f1aDa76aE19A6C09bED2737',
                6,
                'USDC',
                'USD Coin'
              ),
            ],
          },
          executionPrice: {
            toSignificant: vi.fn(() => '2.0'),
            invert: vi.fn(() => ({ toSignificant: vi.fn(() => '0.5') })),
          },
          nextMidPrice: {
            toSignificant: vi.fn(() => '2.0'),
            invert: vi.fn(() => ({ toSignificant: vi.fn(() => '0.5') })),
          },
          slippageTolerance: new Percent('50', '10000'), // 0.5%
          minimumAmountOut: vi.fn(() => new MockCurrencyAmount(mockUsdc, BigInt('1990000'))),
          // Add mock for worseTradeExactIn if needed by the client
        },
      ]),
      bestTradeExactOut: vi.fn(() => [
        {
          inputAmount: new MockCurrencyAmount(
            mockToken(
              actual.ChainId.MATIC,
              '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
              18,
              'WMATIC',
              'Wrapped MATIC'
            ),
            BigInt('1000000000000000000')
          ),
          outputAmount: new MockCurrencyAmount(
            mockToken(
              actual.ChainId.MATIC,
              '0x2791B072600277340f1aDa76aE19A6C09bED2737',
              6,
              'USDC',
              'USD Coin'
            ),
            BigInt('2000000')
          ),
          route: {
            path: [
              mockToken(
                actual.ChainId.MATIC,
                '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
                18,
                'WMATIC',
                'Wrapped MATIC'
              ),
              mockToken(
                actual.ChainId.MATIC,
                '0x2791B072600277340f1aDa76aE19A6C09bED2737',
                6,
                'USDC',
                'USD Coin'
              ),
            ],
          },
          executionPrice: {
            toSignificant: vi.fn(() => '2.0'),
            invert: vi.fn(() => ({ toSignificant: vi.fn(() => '0.5') })),
          },
          nextMidPrice: {
            toSignificant: vi.fn(() => '2.0'),
            invert: vi.fn(() => ({ toSignificant: vi.fn(() => '0.5') })),
          },
          slippageTolerance: new Percent('50', '10000'), // 0.5%
          maximumAmountIn: vi.fn(
            () => new MockCurrencyAmount(mockWmatic, BigInt('1005000000000000000'))
          ),
        },
      ]),
    },
    Router: {
      swapExactTokensForTokens: vi.fn(() => '0xmockSwapTransactionData'),
      swapTokensForExactTokens: vi.fn(() => '0xmockSwapTransactionData'),
      addLiquidity: vi.fn(() => '0xmockAddLiquidityTransactionData'),
      removeLiquidityETH: vi.fn(() => '0xmockRemoveLiquidityETHTransactionData'),
      removeLiquidity: vi.fn(() => '0xmockRemoveLiquidityTransactionData'),
    },
    ChainId: actual.ChainId,
    CurrencyAmount: MockCurrencyAmount, // Use our mock CurrencyAmount
    Percent: actual.Percent,
    TokenAmount: MockTokenAmount, // Use our mock TokenAmount
    Pair: actual.Pair,
  };
});

describe('QuickswapClient', () => {
  let runtime: IAgentRuntime;
  let client: any;

  beforeEach(async () => {
    runtime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'QUICKSWAP_API_URL') return 'http://mock-quickswap-api.com';
        if (key === 'WALLET_PRIVATE_KEY') return '0xmockPrivateKey';
        if (key === 'POLYGONSCAN_API_KEY') return 'mockPolygonscanApiKey';
        return undefined;
      }),
      // Mock other necessary runtime methods if accessed by quickswapClient.ts
    } as any;
    client = await initializeQuickswapClient(runtime);
  });

  it('should initialize the client successfully', async () => {
    expect(client).toBeDefined();
    expect(client.provider).toBeDefined();
    expect(client.wallet).toBeDefined();
    expect(client.routerContract).toBeDefined();
    expect(client.polygonscanApiKey).toBe('mockPolygonscanApiKey');
  });

  it('should handle unknown tokens by fetching contract details', async () => {
    const token = await client.getToken('0xMockContractAddress');
    expect(token).toBeDefined();
    expect(token.symbol).toBe('MOCK');
    expect(token.decimals).toBe(18);
  });

  it('should handle contract fetching failure gracefully', async () => {
    const invalidAddress = '0xInvalidContractAddress';
    vi.spyOn(vi.mocked(Contract).prototype, 'symbol').mockImplementationOnce(() =>
      Promise.reject(new Error('Contract fetch failed'))
    );

    await expect(client.getToken(invalidAddress)).rejects.toThrow(
      `Could not retrieve token information for ${invalidAddress}`
    );
  });

  it('should execute a swap successfully', async () => {
    const swapResult = await client.Swap('WMATIC', 'USDC', 1);
    expect(swapResult.success).toBe(true);
    expect(swapResult.amountReceived).toBeTypeOf('number');
    expect(swapResult.transactionHash).toBe('0xmockTransactionHash');
  });

  it('should handle swap failure', async () => {
    vi.spyOn(vi.mocked(Router), 'bestTradeExactIn').mockReturnValueOnce([]);

    const swapResult = await client.Swap('WMATIC', 'USDC', 1);
    expect(swapResult.success).toBe(false);
    expect(swapResult.error).toBe('No trade could be found for the given amount.');
  });

  it('should add liquidity successfully', async () => {
    const addLiquidityResult = await client.AddLiquidity('WMATIC', 'USDC', 10, 5);
    expect(addLiquidityResult.success).toBe(true);
    expect(addLiquidityResult.lpTokensReceived).toBeTypeOf('number');
    expect(addLiquidityResult.transactionHash).toBe('0xmockTransactionHash');
  });

  it('should remove liquidity successfully', async () => {
    const removeLiquidityResult = await client.RemoveLiquidity('WMATIC', 'USDC', 100);
    expect(removeLiquidityResult.success).toBe(true);
    expect(removeLiquidityResult.token0Received).toBeTypeOf('number');
    expect(removeLiquidityResult.token1Received).toBeTypeOf('number');
    expect(removeLiquidityResult.transactionHash).toBe('0xmockTransactionHash');
  });

  it('should get transaction status for a successful transaction', async () => {
    const statusResult = await client.GetTransactionStatus('0xSuccessTxHash');
    expect(statusResult.success).toBe(true);
    expect(statusResult.status).toBe('success');
    expect(statusResult.blockNumber).toBe(123);
    expect(statusResult.gasUsed).toBeTypeOf('number');
  });

  it('should get transaction status for a pending transaction', async () => {
    const statusResult = await client.GetTransactionStatus('0xPendingTxHash');
    expect(statusResult.success).toBe(true);
    expect(statusResult.status).toBe('pending');
    expect(statusResult.blockNumber).toBeUndefined();
  });

  it('should calculate liquidity value successfully', async () => {
    const liquidityValueResult = await client.CalculateLiquidityValue('WMATIC', 'USDC', 10);
    expect(liquidityValueResult.success).toBe(true);
    expect(liquidityValueResult.token0Value).toBeTypeOf('number');
    expect(liquidityValueResult.token1Value).toBeTypeOf('number');
  });

  it('should calculate mid price successfully', async () => {
    const midPriceResult = await client.CalculateMidPrice('WMATIC', 'USDC');
    expect(midPriceResult.success).toBe(true);
    expect(midPriceResult.midPrice).toBeTypeOf('number');
    expect(midPriceResult.invertedPrice).toBeTypeOf('number');
  });

  it('should calculate token price successfully', async () => {
    const tokenPriceResult = await client.CalculateTokenPrice('WMATIC', 'USDC');
    expect(tokenPriceResult.success).toBe(true);
    expect(tokenPriceResult.price).toBeTypeOf('number');
  });

  it('should execute a limit order', async () => {
    const orderResult = await client.ExecuteOrder({
      tradeType: 'limit',
      inputTokenSymbolOrAddress: 'WMATIC',
      outputTokenSymbolOrAddress: 'USDC',
      amount: '1',
      price: '2',
    });
    expect(orderResult.success).toBe(true);
    expect(orderResult.transactionHash).toBe('0xmockTransactionHash');
  });

  it('should execute a stop-loss order', async () => {
    const orderResult = await client.ExecuteOrder({
      tradeType: 'stop-loss',
      inputTokenSymbolOrAddress: 'ETH',
      outputTokenSymbolOrAddress: 'USDC',
      amount: '5',
      price: '0',
      stopPrice: '1800',
    });
    expect(orderResult.success).toBe(true);
    expect(orderResult.transactionHash).toBe('0xmockTransactionHash');
  });

  it('should execute a take-profit order', async () => {
    const orderResult = await client.ExecuteOrder({
      tradeType: 'take-profit',
      inputTokenSymbolOrAddress: 'BTC',
      outputTokenSymbolOrAddress: 'USDC',
      amount: '2',
      price: '0',
      takeProfitPrice: '30000',
    });
    expect(orderResult.success).toBe(true);
    expect(orderResult.transactionHash).toBe('0xmockTransactionHash');
  });

  it('should get farming pool details', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchTokenData').mockImplementation(
      (chainId, address, provider) => {
        if (address.toLowerCase() === '0xmocktoken0address') {
          return Promise.resolve(mockToken(chainId, address, 18, 'MOCK0', 'Mock Token 0'));
        }
        if (address.toLowerCase() === '0xmocktoken1address') {
          return Promise.resolve(mockToken(chainId, address, 18, 'MOCK1', 'Mock Token 1'));
        }
        return Promise.reject(new Error('Token not found'));
      }
    );

    vi.spyOn(vi.mocked(Contract).prototype, 'name').mockResolvedValueOnce('Mock Farming Pool');
    vi.spyOn(vi.mocked(Contract).prototype, 'rewardsToken').mockResolvedValueOnce(
      '0xmockRewardTokenAddress'
    );
    vi.spyOn(vi.mocked(Contract).prototype, 'totalStaked').mockResolvedValueOnce(
      BigInt('1000000000000000000000')
    );
    vi.spyOn(vi.mocked(Contract).prototype, 'rewardRate').mockResolvedValueOnce(
      BigInt('1000000000000000000')
    );
    vi.spyOn(vi.mocked(Contract).prototype, 'periodFinish').mockResolvedValueOnce(
      Math.floor(Date.now() / 1000) + 86400
    );

    const poolDetailsResult = await client.getFarmingPoolDetails({
      poolId: '1',
      token0SymbolOrAddress: '0xmocktoken0address',
      token1SymbolOrAddress: '0xmocktoken1address',
    });
    expect(poolDetailsResult.success).toBe(true);
    expect(poolDetailsResult.poolId).toBe('1');
    expect(poolDetailsResult.name).toBe('Mock Farming Pool');
    expect(poolDetailsResult.apr).toBeCloseTo(315.36); // Approx. APR for 1 token/sec reward rate over a year
    expect(poolDetailsResult.totalStaked).toBeTypeOf('number');
    expect(poolDetailsResult.rewardTokenSymbol).toBe('MOCK');
  });

  it('should estimate gas fees', async () => {
    vi.spyOn(vi.mocked(JsonRpcProvider).prototype, 'getFeeData').mockResolvedValueOnce({
      gasPrice: BigInt('10000000000'),
      maxFeePerGas: BigInt('20000000000'),
      maxPriorityFeePerGas: BigInt('1500000000'),
      gasLimit: undefined,
    } as any);

    const gasFeeResult = await client.estimateGasFees(
      '0xmockWalletAddress',
      '0xmockToAddress',
      '1000000000000000000'
    );
    expect(gasFeeResult.success).toBe(true);
    expect(gasFeeResult.gasPriceGwei).toBeTypeOf('number');
    expect(gasFeeResult.estimatedFeeMatic).toBeTypeOf('number');
  });

  it('should claim farming rewards', async () => {
    vi.spyOn(vi.mocked(Contract).prototype, 'earned').mockResolvedValueOnce(
      BigInt('10000000000000000000')
    ); // 10 rewards
    vi.spyOn(vi.mocked(Contract).prototype, 'getReward').mockResolvedValueOnce({
      hash: '0xmockRewardClaimTxHash',
      wait: vi.fn(() => Promise.resolve({ status: 1 })),
    });
    vi.spyOn(vi.mocked(Fetcher), 'fetchTokenData').mockResolvedValueOnce(
      mockToken(ChainId.MATIC, '0xmockRewardTokenAddress', 18, 'REWARD', 'Reward Token')
    );

    const rewardsResult = await client.claimFarmingRewards({
      poolId: '1',
      walletAddress: '0xmockWalletAddress',
    });

    expect(rewardsResult.success).toBe(true);
    expect(rewardsResult.rewardsClaimed).toBe(10);
    expect(rewardsResult.rewardsTokenSymbol).toBe('REWARD');
    expect(rewardsResult.transactionHash).toBe('0xmockRewardClaimTxHash');
  });

  it('should handle claim farming rewards failure', async () => {
    vi.spyOn(vi.mocked(Contract).prototype, 'getReward').mockImplementationOnce(() => {
      throw new Error('Failed to claim rewards on chain');
    });

    const rewardsResult = await client.claimFarmingRewards({
      poolId: '1',
      walletAddress: '0xmockWalletAddress',
    });

    expect(rewardsResult.success).toBe(false);
    expect(rewardsResult.error).toBe('Failed to claim rewards on chain');
  });

  // Test cases for error handling and edge cases

  it('should handle getTransactionStatus error for invalid hash', async () => {
    vi.spyOn(vi.mocked(JsonRpcProvider).prototype, 'getTransactionReceipt').mockResolvedValueOnce(
      null
    );
    vi.spyOn(vi.mocked(JsonRpcProvider).prototype, 'getTransaction').mockResolvedValueOnce(null);

    const statusResult = await client.GetTransactionStatus('0xInvalidHash');
    expect(statusResult.success).toBe(false);
    expect(statusResult.error).toBe('Transaction not found or confirmed.');
  });

  it('should handle getToken error when contract fetching fails', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchTokenData').mockImplementationOnce(() =>
      Promise.reject(new Error('Fetcher error'))
    );
    vi.spyOn(vi.mocked(Contract).prototype, 'symbol').mockImplementationOnce(() =>
      Promise.reject(new Error('Contract symbol error'))
    );

    const tokenResult = await client.getToken('0xNonExistentToken');
    expect(tokenResult).toBeUndefined();
  });

  it('should handle calculateMidPrice error when pair data is not found', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchPairData').mockImplementationOnce(() =>
      Promise.reject(new Error('Pair not found'))
    );

    const midPriceResult = await client.CalculateMidPrice('WMATIC', 'UNKNOWN');
    expect(midPriceResult.success).toBe(false);
    expect(midPriceResult.error).toBe('Failed to fetch pair data: Pair not found');
  });

  it('should handle calculateTokenPrice error when pair data is not found', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchPairData').mockImplementationOnce(() =>
      Promise.reject(new Error('Pair not found'))
    );

    const tokenPriceResult = await client.CalculateTokenPrice('WMATIC', 'UNKNOWN');
    expect(tokenPriceResult.success).toBe(false);
    expect(tokenPriceResult.error).toBe('Failed to fetch pair data: Pair not found');
  });

  it('should handle addLiquidity error when pair data is not found', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchPairData').mockImplementationOnce(() =>
      Promise.reject(new Error('Pair not found'))
    );

    const addLiquidityResult = await client.AddLiquidity('WMATIC', 'UNKNOWN', 10, 5);
    expect(addLiquidityResult.success).toBe(false);
    expect(addLiquidityResult.error).toBe('Failed to fetch pair data: Pair not found');
  });

  it('should handle removeLiquidity error when pair data is not found', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchPairData').mockImplementationOnce(() =>
      Promise.reject(new Error('Pair not found'))
    );

    const removeLiquidityResult = await client.RemoveLiquidity('WMATIC', 'UNKNOWN', 100);
    expect(removeLiquidityResult.success).toBe(false);
    expect(removeLiquidityResult.error).toBe('Failed to fetch pair data: Pair not found');
  });

  it('should handle calculateLiquidityValue error when pair data is not found', async () => {
    vi.spyOn(vi.mocked(Fetcher), 'fetchPairData').mockImplementationOnce(() =>
      Promise.reject(new Error('Pair not found'))
    );

    const liquidityValueResult = await client.CalculateLiquidityValue('WMATIC', 'UNKNOWN', 10);
    expect(liquidityValueResult.success).toBe(false);
    expect(liquidityValueResult.error).toBe('Failed to fetch pair data: Pair not found');
  });

  it('should handle executeOrder error for invalid trade type', async () => {
    const orderResult = await client.ExecuteOrder({
      tradeType: 'invalidType',
      inputTokenSymbolOrAddress: 'WMATIC',
      outputTokenSymbolOrAddress: 'USDC',
      amount: '1',
      price: '2',
    });
    expect(orderResult.success).toBe(false);
    expect(orderResult.error).toBe('Invalid trade type provided.');
  });

  it('should handle getFarmingPoolDetails error when details cannot be fetched', async () => {
    vi.spyOn(vi.mocked(Contract).prototype, 'name').mockImplementationOnce(() =>
      Promise.reject(new Error('Contract call failed'))
    );

    const poolDetailsResult = await client.getFarmingPoolDetails({
      poolId: '999',
    });
    expect(poolDetailsResult.success).toBe(false);
    expect(poolDetailsResult.error).toBe(
      'Failed to fetch farming pool details: Contract call failed'
    );
  });

  it('should handle estimateGasFees error', async () => {
    vi.spyOn(vi.mocked(JsonRpcProvider).prototype, 'getFeeData').mockImplementationOnce(() => {
      throw new Error('RPC error during gas estimation');
    });

    const gasFeeResult = await client.estimateGasFees(
      '0xmockWalletAddress',
      '0xmockToAddress',
      '1000000000000000000'
    );
    expect(gasFeeResult.success).toBe(false);
    expect(gasFeeResult.error).toBe('Failed to estimate gas fees: RPC error during gas estimation');
  });
});
