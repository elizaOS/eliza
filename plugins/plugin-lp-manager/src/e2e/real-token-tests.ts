import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { setupScenario, sendMessageAndWaitForResponse } from './test-utils.ts';
import type { PoolInfo, TokenBalance, LpPositionDetails } from '../types.ts';
import { DexInteractionService } from '../services/DexInteractionService.ts';
import { VaultService } from '../services/VaultService.ts';
import { UserLpProfileService } from '../services/UserLpProfileService.ts';
import { YieldOptimizationService } from '../services/YieldOptimizationService.ts';

// Real token addresses on Solana mainnet
const TOKEN_ADDRESSES = {
  SOL: 'So11111111111111111111111111111111111111112',
  AI16Z: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', // ai16z Token2022 token
  DEGENAI: 'Gu3LDkn7VuCUNWpwxHpCpbNq7zWcHrZsQ8o8TDk1GDwT', // degenai standard SPL token
};

/**
 * Defines a suite of E2E tests for real token interactions.
 * These tests interact with actual DEX protocols on Solana mainnet.
 */
export const realTokenTestsSuite: TestSuite = {
  name: 'LP Manager Real Token Integration Tests',
  tests: [
    {
      name: "Test 1: Discover ai16z/SOL pools across DEXs",
      fn: async (runtime: IAgentRuntime) => {
        // Get the DEX interaction service
        const dexService = runtime.getService<DexInteractionService>('dex-interaction');
        assert(dexService, 'DexInteractionService should be available');

        // Search for ai16z/SOL pools
        console.log('Searching for ai16z/SOL pools...');
        const pools = await dexService.getPools(undefined, TOKEN_ADDRESSES.AI16Z, TOKEN_ADDRESSES.SOL);
        
        console.log(`Found ${pools.length} ai16z/SOL pools:`);
        pools.forEach(pool => {
          console.log(`- ${pool.dex}: ${pool.id} (APR: ${pool.apr}%, TVL: $${pool.tvl})`);
        });

        // Assert that we found at least one pool
        assert(
          pools.length > 0,
          'Should find at least one ai16z/SOL pool'
        );

        // Test pool data integrity
        pools.forEach(pool => {
          assert(pool.id, 'Pool should have an ID');
          assert(pool.dex, 'Pool should have a DEX name');
          assert(
            (pool.tokenA.mint === TOKEN_ADDRESSES.AI16Z && pool.tokenB.mint === TOKEN_ADDRESSES.SOL) ||
            (pool.tokenA.mint === TOKEN_ADDRESSES.SOL && pool.tokenB.mint === TOKEN_ADDRESSES.AI16Z),
            'Pool should contain ai16z and SOL tokens'
          );
        });
      },
    },

    {
      name: "Test 2: Discover degenai/SOL pools across DEXs",
      fn: async (runtime: IAgentRuntime) => {
        const dexService = runtime.getService<DexInteractionService>('dex-interaction');
        assert(dexService, 'DexInteractionService should be available');

        // Search for degenai/SOL pools
        console.log('Searching for degenai/SOL pools...');
        const pools = await dexService.getPools(undefined, TOKEN_ADDRESSES.DEGENAI, TOKEN_ADDRESSES.SOL);
        
        console.log(`Found ${pools.length} degenai/SOL pools:`);
        pools.forEach(pool => {
          console.log(`- ${pool.dex}: ${pool.id} (APR: ${pool.apr}%, TVL: $${pool.tvl})`);
        });

        // Assert that we found at least one pool
        assert(
          pools.length > 0,
          'Should find at least one degenai/SOL pool'
        );

        // Test pool data integrity
        pools.forEach(pool => {
          assert(pool.id, 'Pool should have an ID');
          assert(pool.dex, 'Pool should have a DEX name');
          assert(
            (pool.tokenA.mint === TOKEN_ADDRESSES.DEGENAI && pool.tokenB.mint === TOKEN_ADDRESSES.SOL) ||
            (pool.tokenA.mint === TOKEN_ADDRESSES.SOL && pool.tokenB.mint === TOKEN_ADDRESSES.DEGENAI),
            'Pool should contain degenai and SOL tokens'
          );
        });
      },
    },

    {
      name: "Test 3: Compare APR across different DEXs for ai16z/SOL",
      fn: async (runtime: IAgentRuntime) => {
        const dexService = runtime.getService<DexInteractionService>('dex-interaction');
        assert(dexService, 'DexInteractionService should be available');

        const pools = await dexService.getPools(undefined, TOKEN_ADDRESSES.AI16Z, TOKEN_ADDRESSES.SOL);
        
        if (pools.length === 0) {
          console.log('No ai16z/SOL pools found, skipping APR comparison');
          return;
        }

        // Sort pools by APR
        const sortedPools = pools.sort((a, b) => (b.apr || 0) - (a.apr || 0));
        
        console.log('APR Comparison for ai16z/SOL pools:');
        sortedPools.forEach(pool => {
          console.log(`- ${pool.dex}: ${pool.apr || 0}% APR (TVL: $${pool.tvl || 0})`);
        });

        // Find best APR
        const bestPool = sortedPools[0];
        console.log(`\nBest APR: ${bestPool.apr || 0}% on ${bestPool.dex}`);

        assert(
          bestPool.apr !== undefined && bestPool.apr >= 0,
          'Best pool should have a valid APR'
        );
      },
    },

    {
      name: "Test 4: Simulate liquidity addition workflow for degenai/SOL",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // First, check available pools
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Show me all degenai/SOL pools with their APR"
        );

        console.log('Pool discovery response:', response1.text || 'No text response');

        assert.match(
          response1.text || '',
          /pool|degenai|SOL|APR|liquidity/i,
          'Response should mention pools and APR'
        );

        // Then simulate adding liquidity
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to add 0.1 SOL and equivalent degenai to the best APR pool"
        );

        console.log('Add liquidity response:', response2.text || 'No text response');

        assert.match(
          response2.text || '',
          /add|liquidity|SOL|degenai|pool/i,
          'Response should acknowledge liquidity addition request'
        );
      },
    },

    {
      name: "Test 5: Test position tracking after liquidity addition",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Check LP positions
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Show me all my LP positions including underlying token amounts"
        );

        console.log('LP positions response:', response.text || 'No text response');

        assert.match(
          response.text || '',
          /position|LP|liquidity|token|amount/i,
          'Response should show LP positions'
        );
      },
    },

    {
      name: "Test 6: Test yield optimization opportunities",
      fn: async (runtime: IAgentRuntime) => {
        const yieldService = runtime.getService<YieldOptimizationService>('YieldOptimizationService');
        assert(yieldService, 'YieldOptimizationService should be available');

        // Fetch all pool data
        console.log('Fetching all pool data for yield analysis...');
        const allPools = await yieldService.fetchAllPoolData();
        
        console.log(`Total pools available: ${allPools.length}`);

        // Filter for our target tokens
        const targetPools = allPools.filter(pool => 
          (pool.tokenA.mint === TOKEN_ADDRESSES.AI16Z || pool.tokenB.mint === TOKEN_ADDRESSES.AI16Z) ||
          (pool.tokenA.mint === TOKEN_ADDRESSES.DEGENAI || pool.tokenB.mint === TOKEN_ADDRESSES.DEGENAI)
        );

        console.log(`Pools with ai16z or degenai: ${targetPools.length}`);
        
        // Group by token pair and find best APR
        const bestByPair = new Map<string, PoolInfo>();
        
        targetPools.forEach(pool => {
          const pair = [pool.tokenA.symbol, pool.tokenB.symbol].sort().join('/');
          const current = bestByPair.get(pair);
          
          if (!current || (pool.apr || 0) > (current.apr || 0)) {
            bestByPair.set(pair, pool);
          }
        });

        console.log('\nBest APR pools by pair:');
        bestByPair.forEach((pool, pair) => {
          console.log(`- ${pair}: ${pool.apr || 0}% on ${pool.dex}`);
        });

        assert(
          targetPools.length > 0,
          'Should find at least one pool with target tokens'
        );
      },
    },

    {
      name: "Test 7: Test auto-rebalance configuration",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Configure auto-rebalance preferences
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Enable auto-rebalance with 3% minimum gain, prefer Orca and Raydium DEXs, max slippage 0.5%"
        );

        console.log('Auto-rebalance config response:', response.text || 'No text response');

        assert.match(
          response.text || '',
          /auto.*rebalance|enable|3%|Orca|Raydium|slippage/i,
          'Response should acknowledge auto-rebalance configuration'
        );
      },
    },

    {
      name: "Test 8: Test liquidity removal workflow",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Request to remove liquidity
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to remove 50% of my degenai/SOL LP position"
        );

        console.log('Remove liquidity response:', response.text || 'No text response');

        assert.match(
          response.text || '',
          /remove|withdraw|50%|liquidity|degenai|SOL/i,
          'Response should acknowledge liquidity removal request'
        );
      },
    },

    {
      name: "Test 9: Test handling of Token2022 (ai16z) specifics",
      fn: async (runtime: IAgentRuntime) => {
        const dexService = runtime.getService<DexInteractionService>('dex-interaction');
        assert(dexService, 'DexInteractionService should be available');

        // Get pools for ai16z (Token2022)
        const pools = await dexService.getPools(undefined, TOKEN_ADDRESSES.AI16Z, TOKEN_ADDRESSES.SOL);
        
        console.log('Checking Token2022 compatibility:');
        
        // Check which DEXs support Token2022
        const dexSupport = new Map<string, number>();
        pools.forEach(pool => {
          dexSupport.set(pool.dex, (dexSupport.get(pool.dex) || 0) + 1);
        });

        console.log('DEXs supporting ai16z (Token2022):');
        dexSupport.forEach((count, dex) => {
          console.log(`- ${dex}: ${count} pools`);
        });

        // Note: Some DEXs may not support Token2022
        console.log('\nNote: Some DEXs may not support Token2022 tokens like ai16z');
      },
    },

    {
      name: "Test 10: End-to-end LP lifecycle test",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // 1. Onboard user
        console.log('Step 1: Onboarding...');
        const onboardResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to start LP management with auto-rebalancing enabled"
        );
        console.log('Onboard response:', onboardResponse.text || 'No text response');

        // 2. Check available pools
        console.log('\nStep 2: Checking pools...');
        const poolsResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Show me the best APR pools for SOL pairs"
        );
        console.log('Pools response:', poolsResponse.text || 'No text response');

        // 3. Add liquidity
        console.log('\nStep 3: Adding liquidity...');
        const addResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Add 0.2 SOL to the best SOL pool you can find"
        );
        console.log('Add liquidity response:', addResponse.text || 'No text response');

        // 4. Check positions
        console.log('\nStep 4: Checking positions...');
        const positionsResponse = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Show me my current LP positions and their performance"
        );
        console.log('Positions response:', positionsResponse.text || 'No text response');

        // Assert responses are meaningful
        assert((onboardResponse.text?.length || 0) > 0, 'Onboard response should not be empty');
        assert((poolsResponse.text?.length || 0) > 0, 'Pools response should not be empty');
        assert((addResponse.text?.length || 0) > 0, 'Add liquidity response should not be empty');
        assert((positionsResponse.text?.length || 0) > 0, 'Positions response should not be empty');
      },
    },
  ],
}; 