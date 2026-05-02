import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { Keypair } from '@solana/web3.js';
import { MeteoraLpService } from '../services/MeteoraLpService.ts';
import { meteoraPositionProvider } from '../providers/positionProvider.ts';

/**
 * Defines a suite of E2E tests for Meteora LP management scenarios.
 * 
 * These scenarios test the agent's ability to handle real-world Meteora DEX
 * interactions including pool discovery, liquidity provision, position management,
 * and market data retrieval.
 */
export const meteoraScenarios: TestSuite = {
  name: 'Meteora Plugin E2E Scenarios',
  tests: [
    {
      name: "Scenario 1: Pool Discovery and Fetching",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Meteora pool discovery...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        assert(meteoraService, 'MeteoraLpService should be available');
        
        // Test getting all pools
        const allPools = await meteoraService.getPools();
        console.log(`Found ${allPools.length} Meteora pools`);
        
        assert(Array.isArray(allPools), 'getPools should return an array');
        assert(allPools.length > 0, 'Should find at least one pool');
        
        // Verify pool structure
        const pool = allPools[0];
        assert(typeof pool.id === 'string', 'Pool should have string ID');
        assert(pool.dex === 'meteora', 'Pool should be identified as meteora');
        assert(pool.tokenA && pool.tokenB, 'Pool should have tokenA and tokenB');
        assert(typeof pool.tokenA.mint === 'string', 'Token should have mint address');
        assert(typeof pool.tokenA.symbol === 'string', 'Token should have symbol');
        
        console.log('✅ Pool discovery test passed');
      },
    },

    {
      name: "Scenario 2: Filtered Pool Search",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing filtered pool search...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // Test with specific token pair filter
        const solUsdcMint = 'So11111111111111111111111111111111111111112'; // SOL
        const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
        
        const filteredPools = await meteoraService.getPools(solUsdcMint, usdcMint);
        console.log(`Found ${filteredPools.length} SOL-USDC pools`);
        
        assert(Array.isArray(filteredPools), 'Filtered search should return array');
        
        // If pools found, verify they match the filter
        if (filteredPools.length > 0) {
          const pool = filteredPools[0];
          const hasCorrectPair = 
            (pool.tokenA.mint === solUsdcMint && pool.tokenB.mint === usdcMint) ||
            (pool.tokenA.mint === usdcMint && pool.tokenB.mint === solUsdcMint);
          assert(hasCorrectPair, 'Filtered pool should match requested token pair');
        }
        
        console.log('✅ Filtered pool search test passed');
      },
    },

    {
      name: "Scenario 3: Market Data Retrieval",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing market data retrieval...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // First get some pools to test with
        const pools = await meteoraService.getPools();
        assert(pools.length > 0, 'Need at least one pool for market data test');
        
        const poolIds = pools.slice(0, 3).map(p => p.id); // Test with first 3 pools
        const marketData = await meteoraService.getMarketDataForPools(poolIds);
        
        assert(typeof marketData === 'object', 'Market data should be an object');
        
        // Check that we got data for requested pools
        let foundData = false;
        for (const poolId of poolIds) {
          const data = marketData[poolId];
          if (data) {
            foundData = true;
            console.log(`Pool ${poolId}: APY=${data.apy}, TVL=${data.tvl}`);
            assert(typeof data.apy === 'number' || data.apy === undefined, 'APY should be number or undefined');
            assert(typeof data.tvl === 'number' || data.tvl === undefined, 'TVL should be number or undefined');
          } else {
            console.log(`No market data found for pool ${poolId}`);
          }
        }
        assert(foundData, 'Should have found market data for at least one pool');
        
        console.log('✅ Market data retrieval test passed');
      },
    },

    {
      name: "Scenario 4: DEX Name Verification",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing DEX name identification...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        const dexName = meteoraService.getDexName();
        assert.strictEqual(dexName, 'meteora', 'DEX name should be "meteora"');
        
        console.log('✅ DEX name verification test passed');
      },
    },

    {
      name: "Scenario 5: Position Provider Integration",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing position provider integration...');
        
        // Test that the position provider is properly registered and can be called
        // Create a minimal Memory object for testing
        const testMemory = {
          id: 'test-memory-id',
          userId: 'test-user',
          agentId: 'test-agent',
          roomId: 'test-room',
          content: { text: 'test message' },
          createdAt: Date.now(),
        } as any;
        
        const context = await meteoraPositionProvider.get(runtime, testMemory, {} as any);
        
        assert(typeof context === 'object' && context !== null, 'Position provider should return an object');
        assert('data' in context, 'Context should have data property');
        assert('values' in context, 'Context should have values property');
        assert('text' in context, 'Context should have text property');
        assert(context.data && Array.isArray(context.data.positions), 'Positions should be an array in data');
        
        console.log('Position provider context:', context);
        console.log('✅ Position provider integration test passed');
      },
    },

    {
      name: "Scenario 6: Service Lifecycle",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing service lifecycle...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // Test start/stop methods exist and can be called
        assert(typeof meteoraService.stop === 'function', 'Service should have stop method');
        
        // These should not throw errors
        await meteoraService.stop();
        
        console.log('✅ Service lifecycle test passed');
      },
    },

    {
      name: "Scenario 7: Error Handling for Invalid Pool ID",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing error handling for invalid operations...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // Test with invalid pool ID
        const invalidPoolId = 'invalid-pool-id-12345';
        const userKeypair = Keypair.generate();
        
        const result = await meteoraService.addLiquidity({
          userVault: userKeypair,
          poolId: invalidPoolId,
          tokenAAmountLamports: '1000000', // 0.001 SOL
          slippageBps: 100, // 1%
        });
        
        assert(!result.success, 'Should fail with invalid pool ID');
        assert(typeof result.error === 'string', 'Should return error message');
        assert(result.error.length > 0, 'Error message should not be empty');
        
        console.log('Expected error for invalid pool:', result.error);
        console.log('✅ Error handling test passed');
      },
    },

    {
      name: "Scenario 8: Position Details for Non-existent User",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing position details for non-existent user...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // Use a random public key that likely has no positions
        const randomUser = Keypair.generate().publicKey.toBase58();
        
        // Get a real pool ID to test with
        const pools = await meteoraService.getPools();
        if (pools.length === 0) {
          console.log('Skipping test - no pools available');
          return;
        }
        
        const poolId = pools[0].id;
        const positionDetails = await meteoraService.getLpPositionDetails(randomUser, poolId);
        
        // Should return null for user with no positions
        assert(positionDetails === null, 'Should return null for user with no positions');
        
        console.log('✅ Position details test passed');
      },
    },

    {
      name: "Scenario 9: Remove Liquidity Error Handling",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing remove liquidity error handling...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // Get a real pool ID
        const pools = await meteoraService.getPools();
        if (pools.length === 0) {
          console.log('Skipping test - no pools available');
          return;
        }
        
        const userKeypair = Keypair.generate();
        const result = await meteoraService.removeLiquidity({
          userVault: userKeypair,
          poolId: pools[0].id,
          lpTokenAmountLamports: '1000000',
          slippageBps: 100,
        });
        
        // Should fail because user has no positions
        assert(!result.success, 'Should fail when user has no positions');
        assert(typeof result.error === 'string', 'Should return error message');
        
        // The error could be either "No positions found" or an RPC error
        const isExpectedError = result.error.includes('No positions found') || 
                              result.error.includes('RPC') || 
                              result.error.includes('410 Gone') ||
                              result.error.includes('disabled');
        assert(isExpectedError, `Error should mention no positions found or be an RPC error. Got: ${result.error}`);
        
        console.log('Expected error:', result.error);
        console.log('✅ Remove liquidity error handling test passed');
      },
    },

    {
      name: "Scenario 10: Integration Test - Full Workflow Simulation",
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing full workflow simulation...');
        
        const meteoraService = runtime.getService('meteora-lp') as MeteoraLpService;
        
        // 1. Discover pools
        const pools = await meteoraService.getPools();
        assert(pools.length > 0, 'Should have pools available');
        
        // 2. Get market data for a pool
        const testPool = pools[0];
        const marketData = await meteoraService.getMarketDataForPools([testPool.id]);
        assert(marketData[testPool.id] !== undefined, 'Should get market data for test pool');
        
        // 3. Check position provider context
        const testMemory2 = {
          id: 'test-memory-id-2',
          userId: 'test-user',
          agentId: 'test-agent',
          roomId: 'test-room',
          content: { text: 'test message' },
          createdAt: Date.now(),
        } as any;
        
        const context = await meteoraPositionProvider.get(runtime, testMemory2, {} as any);
        assert(typeof context === 'object' && context !== null, 'Position provider should work');
        assert('data' in context && 'values' in context && 'text' in context, 'Context should have required properties');
        
        // 4. Verify service identification
        const dexName = meteoraService.getDexName();
        assert.strictEqual(dexName, 'meteora', 'Should identify as meteora');
        
        console.log(`✅ Full workflow test passed with ${pools.length} pools discovered`);
        console.log(`Test pool: ${testPool.tokenA.symbol}-${testPool.tokenB.symbol}`);
      },
    },
  ],
};

export default meteoraScenarios;
