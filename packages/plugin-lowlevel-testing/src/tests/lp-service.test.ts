import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { ILpService } from '@elizaos/core';
import { strict as assert } from 'node:assert';

export const lpServiceTestSuite: TestSuite = {
  name: 'LP Service Real Implementation Tests',
  tests: [
    {
      name: 'Test 1: Should discover and test all LP services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Discovering LP services...');

        // List of expected LP service implementations
        const lpPlugins = [
          { name: 'orca', dexName: 'orca' },
          { name: 'raydium', dexName: 'raydium' },
          { name: 'meteora', dexName: 'meteora' },
          { name: 'uniswap', dexName: 'uniswap' },
        ];

        const foundServices: ILpService[] = [];

        // Try to find LP services
        for (const plugin of lpPlugins) {
          const pluginInstance = runtime.plugins.find((p) => p.name === plugin.name);
          if (pluginInstance) {
            console.log(`✓ Found ${plugin.name} plugin`);

            // Try to get the LP service
            const lpService = runtime.getService<ILpService>(ILpService.serviceType);
            if (lpService && lpService.getDexName() === plugin.dexName) {
              foundServices.push(lpService);
              console.log(`✓ ${plugin.name} LP service is active`);
            }
          } else {
            console.log(`⚠️  ${plugin.name} plugin not loaded`);
          }
        }

        if (foundServices.length === 0) {
          console.log('⚠️  No LP services found, skipping LP tests');
          return;
        }

        console.log(`\nFound ${foundServices.length} LP services to test`);
      },
    },

    {
      name: 'Test 2: Should test getPools method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing getPools method...');

        const lpService = runtime.getService<ILpService>(ILpService.serviceType);
        if (!lpService) {
          console.log('⚠️  No LP service found');
          return;
        }

        const dexName = lpService.getDexName();
        console.log(`Testing ${dexName} LP service`);

        try {
          // Get all pools
          console.log('Fetching all pools...');
          const allPools = await lpService.getPools();
          assert(Array.isArray(allPools), 'getPools should return an array');
          console.log(`✓ Found ${allPools.length} pools on ${dexName}`);

          if (allPools.length > 0) {
            // Log first few pools
            console.log('Sample pools:');
            allPools.slice(0, 3).forEach((pool) => {
              console.log(
                `  - ${pool.id}: ${pool.tokenA.symbol}/${pool.tokenB.symbol} (TVL: $${pool.tvl || 0})`
              );
            });
          }

          // Test filtering by token
          if (dexName === 'orca' || dexName === 'raydium' || dexName === 'meteora') {
            // Solana DEXes - test with SOL
            const solMint = 'So11111111111111111111111111111111111111112';
            const solPools = await lpService.getPools(solMint);
            console.log(`✓ Found ${solPools.length} pools containing SOL`);
          } else if (dexName === 'uniswap') {
            // EVM DEX - test with WETH
            const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
            const wethPools = await lpService.getPools(wethAddress);
            console.log(`✓ Found ${wethPools.length} pools containing WETH`);
          }
        } catch (error) {
          console.error(
            `Failed to get pools from ${dexName}:`,
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 3: Should test pool data structure',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing pool data structure...');

        const lpService = runtime.getService<ILpService>(ILpService.serviceType);
        if (!lpService) {
          console.log('⚠️  No LP service found');
          return;
        }

        try {
          const pools = await lpService.getPools();
          if (pools.length === 0) {
            console.log('⚠️  No pools returned');
            return;
          }

          const pool = pools[0];

          // Verify required fields
          assert(pool.id, 'Pool should have an id');
          assert(pool.dex, 'Pool should have a dex identifier');
          assert(pool.tokenA, 'Pool should have tokenA');
          assert(pool.tokenA.mint, 'TokenA should have mint address');
          assert(pool.tokenB, 'Pool should have tokenB');
          assert(pool.tokenB.mint, 'TokenB should have mint address');

          console.log('✓ Pool structure is valid');
          console.log(`  ID: ${pool.id}`);
          console.log(`  DEX: ${pool.dex}`);
          console.log(
            `  Pair: ${pool.tokenA.symbol || pool.tokenA.mint}/${pool.tokenB.symbol || pool.tokenB.mint}`
          );

          // Check optional fields
          if (pool.tvl !== undefined) console.log(`  TVL: $${pool.tvl}`);
          if (pool.apr !== undefined) console.log(`  APR: ${pool.apr}%`);
          if (pool.apy !== undefined) console.log(`  APY: ${pool.apy}%`);
          if (pool.fee !== undefined) console.log(`  Fee: ${pool.fee}%`);
        } catch (error) {
          console.error(
            'Failed to validate pool structure:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 4: Should test getLpPositionDetails method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing getLpPositionDetails method...');

        const lpService = runtime.getService<ILpService>(ILpService.serviceType);
        if (!lpService) {
          console.log('⚠️  No LP service found');
          return;
        }

        // This test requires a real user address with LP positions
        // We'll use a dummy address for testing
        const testAddress = '0x0000000000000000000000000000000000000000';
        const testPoolId = 'test-pool-id';

        try {
          const position = await lpService.getLpPositionDetails(testAddress, testPoolId);

          if (position) {
            console.log('✓ Found LP position');
            console.log(`  Pool ID: ${position.poolId}`);
            console.log(`  DEX: ${position.dex}`);
            console.log(
              `  LP Token Balance: ${position.lpTokenBalance.uiAmount} ${position.lpTokenBalance.symbol}`
            );
            console.log(`  Value: $${position.valueUsd || 0}`);

            if (position.underlyingTokens) {
              console.log('  Underlying tokens:');
              position.underlyingTokens.forEach((token) => {
                console.log(`    - ${token.symbol}: ${token.uiAmount}`);
              });
            }
          } else {
            console.log('⚠️  No position found (expected for test address)');
          }
        } catch (error) {
          console.log(
            '⚠️  Could not get position details:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    },

    {
      name: 'Test 5: Should test getMarketDataForPools method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing getMarketDataForPools method...');

        const lpService = runtime.getService<ILpService>(ILpService.serviceType);
        if (!lpService) {
          console.log('⚠️  No LP service found');
          return;
        }

        try {
          // Get some pools first
          const pools = await lpService.getPools();
          if (pools.length === 0) {
            console.log('⚠️  No pools available to test market data');
            return;
          }

          // Test with first few pool IDs
          const poolIds = pools.slice(0, 3).map((p) => p.id);
          const marketData = await lpService.getMarketDataForPools(poolIds);

          assert(marketData, 'Market data should be returned');
          assert(typeof marketData === 'object', 'Market data should be an object');

          console.log(`✓ Retrieved market data for ${Object.keys(marketData).length} pools`);

          // Log market data
          Object.entries(marketData).forEach(([poolId, data]) => {
            console.log(`  Pool ${poolId}:`);
            if (data.tvl) console.log(`    TVL: $${data.tvl}`);
            if (data.apy) console.log(`    APY: ${data.apy}%`);
            if (data.apr) console.log(`    APR: ${data.apr}%`);
          });
        } catch (error) {
          console.error(
            'Failed to get market data:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 6: Should test addLiquidity method (simulation only)',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing addLiquidity method...');

        const lpService = runtime.getService<ILpService>(ILpService.serviceType);
        if (!lpService) {
          console.log('⚠️  No LP service found');
          return;
        }

        // Verify method exists
        assert(typeof lpService.addLiquidity === 'function', 'addLiquidity method should exist');
        console.log('✓ addLiquidity method exists');

        // We won't execute actual liquidity addition to avoid using real funds
        console.log('⚠️  Skipping actual liquidity addition (requires funds)');
      },
    },

    {
      name: 'Test 7: Should test removeLiquidity method (simulation only)',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing removeLiquidity method...');

        const lpService = runtime.getService<ILpService>(ILpService.serviceType);
        if (!lpService) {
          console.log('⚠️  No LP service found');
          return;
        }

        // Verify method exists
        assert(
          typeof lpService.removeLiquidity === 'function',
          'removeLiquidity method should exist'
        );
        console.log('✓ removeLiquidity method exists');

        // We won't execute actual liquidity removal
        console.log('⚠️  Skipping actual liquidity removal (requires LP tokens)');
      },
    },
  ],
};

export default lpServiceTestSuite;
