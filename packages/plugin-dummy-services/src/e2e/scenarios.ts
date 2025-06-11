import type { IAgentRuntime, TestSuite, IWalletService } from '@elizaos/core';
import { ILpService, ServiceType } from '@elizaos/core';
import { strict as assert } from 'node:assert';
import { DummyLpService } from '../lp/service';
import { DummyTokenDataService } from '../tokenData/service';
import { DummyWalletService } from '../wallet/service';
import { setupScenario } from './test-utils';

export const dummyServicesScenariosSuite: TestSuite = {
  name: 'Dummy Services Plugin E2E Scenarios',
  tests: [
    {
      name: 'Scenario 1: Should initialize dummy services and verify they are available',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing dummy services initialization...');

        // Check DummyLpService
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found in runtime');
        assert.equal(
          lpService.getDexName(),
          'dummy',
          'DummyLpService should have correct DEX name'
        );

        // Check DummyTokenDataService
        const tokenDataService = runtime.getService<DummyTokenDataService>(
          DummyTokenDataService.serviceType
        );
        assert(tokenDataService, 'DummyTokenDataService not found in runtime');

        console.log('Successfully verified both dummy services are initialized and available.');
      },
    },
    {
      name: 'Scenario 2: Should fetch pools from DummyLpService',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        console.log('Fetching all pools from DummyLpService...');
        const allPools = await lpService.getPools();
        assert(Array.isArray(allPools), 'getPools should return an array');
        assert.equal(allPools.length, 2, 'Should return 2 dummy pools');

        // Verify pool structure
        const pool1 = allPools.find((p) => p.id === 'dummy-pool-1');
        assert(pool1, 'dummy-pool-1 should exist');
        assert.equal(pool1.dex, 'dummy', 'Pool should have correct DEX');
        assert.equal(pool1.tokenA.symbol, 'SOL', 'Pool should have SOL as tokenA');
        assert.equal(pool1.tokenB.symbol, 'USDC', 'Pool should have USDC as tokenB');
        assert.equal(pool1.tvl, 1234567.89, 'Pool should have correct TVL');

        console.log('Successfully fetched and verified pool data.');
      },
    },
    {
      name: 'Scenario 3: Should filter pools by token mint',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        const solMint = 'So11111111111111111111111111111111111111112';
        console.log(`Filtering pools containing SOL (${solMint})...`);

        const solPools = await lpService.getPools(solMint);
        assert(Array.isArray(solPools), 'getPools with filter should return an array');
        assert(solPools.length > 0, 'Should find pools containing SOL');

        // Verify all returned pools contain SOL
        solPools.forEach((pool) => {
          const containsSol = pool.tokenA.mint === solMint || pool.tokenB.mint === solMint;
          assert(containsSol, `Pool ${pool.id} should contain SOL`);
        });

        console.log(`Found ${solPools.length} pools containing SOL.`);
      },
    },
    {
      name: 'Scenario 4: Should add liquidity to a dummy pool',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        // Create a mock vault object
        const mockVault = { publicKey: 'dummy-public-key', secretKey: 'dummy-secret-key' };

        console.log('Testing add liquidity to dummy-pool-1...');
        const result = await lpService.addLiquidity({
          userVault: mockVault,
          poolId: 'dummy-pool-1',
          tokenAAmountLamports: '1000000000', // 1 SOL
          slippageBps: 100, // 1% slippage
        });

        assert.equal(result.success, true, 'Add liquidity should succeed');
        assert(result.transactionId, 'Should have a transaction ID');
        assert.match(result.transactionId, /^dummy-tx-/, 'Transaction ID should have dummy prefix');
        assert(result.lpTokensReceived, 'Should receive LP tokens');
        assert.equal(
          result.lpTokensReceived?.symbol,
          'DUMMY-LP',
          'LP token should have correct symbol'
        );
        assert.equal(
          result.lpTokensReceived?.address,
          'dummy-lp-mint-dummy-pool-1',
          'LP token should have correct address'
        );

        console.log('Successfully added liquidity:', result);
      },
    },
    {
      name: 'Scenario 5: Should remove liquidity from a dummy pool',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        // Create a mock vault object
        const mockVault = { publicKey: 'dummy-public-key-2', secretKey: 'dummy-secret-key-2' };

        console.log('Testing remove liquidity from dummy-pool-1...');
        const result = await lpService.removeLiquidity({
          userVault: mockVault,
          poolId: 'dummy-pool-1',
          lpTokenAmountLamports: '1000000', // 1 LP token
          slippageBps: 50, // 0.5% slippage
        });

        assert.equal(result.success, true, 'Remove liquidity should succeed');
        assert(result.transactionId, 'Should have a transaction ID');
        assert.match(result.transactionId, /^dummy-tx-/, 'Transaction ID should have dummy prefix');
        assert(result.tokensReceived, 'Should receive tokens');
        assert.equal(result.tokensReceived.length, 2, 'Should receive 2 tokens');

        // Verify underlying tokens
        const solToken = result.tokensReceived.find((t) => t.symbol === 'SOL');
        const usdcToken = result.tokensReceived.find((t) => t.symbol === 'USDC');
        assert(solToken, 'Should receive SOL');
        assert(usdcToken, 'Should receive USDC');
        assert.equal(solToken.uiAmount, 0.5, 'Should receive 0.5 SOL');
        assert.equal(usdcToken.uiAmount, 500, 'Should receive 500 USDC');

        console.log('Successfully removed liquidity:', result);
      },
    },
    {
      name: 'Scenario 6: Should get LP position details',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        const userPublicKey = 'HtiYLjY9dGMrmpwjDcGmxQCo2VsCCAQiBgt5xPLanTJa';
        const lpMint = 'dummy-lp-mint-dummy-pool-1';

        console.log(`Getting LP position details for user ${userPublicKey}...`);
        const position = await lpService.getLpPositionDetails(userPublicKey, lpMint);

        assert(position, 'Should return LP position details');
        assert.equal(position.poolId, 'dummy-pool-1', 'Position should reference correct pool');
        assert.equal(position.dex, 'dummy', 'Position should have correct DEX');
        assert.equal(position.valueUsd, 1000, 'Position should have correct USD value');

        // Verify LP token balance
        assert(position.lpTokenBalance, 'Should have LP token balance');
        assert.equal(
          position.lpTokenBalance.symbol,
          'DUMMY-LP',
          'LP token should have correct symbol'
        );
        assert.equal(position.lpTokenBalance.uiAmount, 100, 'Should have 100 LP tokens');

        // Verify underlying tokens
        assert(position.underlyingTokens, 'Should have underlying tokens');
        assert.equal(position.underlyingTokens.length, 2, 'Should have 2 underlying tokens');

        const sol = position.underlyingTokens.find((t) => t.symbol === 'SOL');
        const usdc = position.underlyingTokens.find((t) => t.symbol === 'USDC');
        assert(sol, 'Should have SOL in underlying tokens');
        assert(usdc, 'Should have USDC in underlying tokens');
        assert.equal(sol.uiAmount, 0.5, 'Should have 0.5 SOL');
        assert.equal(usdc.uiAmount, 500, 'Should have 500 USDC');

        console.log('Successfully retrieved LP position details:', position);
      },
    },
    {
      name: 'Scenario 7: Should get market data for pools',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        const poolIds = ['dummy-pool-1', 'dummy-stable-pool-2'];
        console.log(`Getting market data for pools: ${poolIds.join(', ')}...`);

        const marketData = await lpService.getMarketDataForPools(poolIds);
        assert(marketData, 'Should return market data');
        assert.equal(Object.keys(marketData).length, 2, 'Should have data for 2 pools');

        // Verify market data structure
        poolIds.forEach((poolId) => {
          const data = marketData[poolId];
          assert(data, `Should have market data for ${poolId}`);
          assert(typeof data.tvl === 'number', 'Should have TVL');
          assert(typeof data.apy === 'number', 'Should have APY');
          assert(typeof data.apr === 'number', 'Should have APR');

          // Verify reasonable ranges
          assert(data.tvl >= 0, 'TVL should be non-negative');
          assert(data.apy >= 0 && data.apy <= 1, 'APY should be between 0 and 1');
          assert(data.apr >= 0 && data.apr <= 1, 'APR should be between 0 and 1');
        });

        console.log('Successfully retrieved market data:', marketData);
      },
    },
    {
      name: 'Scenario 8: Should fetch token data from DummyTokenDataService',
      fn: async (runtime: IAgentRuntime) => {
        const tokenDataService = runtime.getService<DummyTokenDataService>(
          DummyTokenDataService.serviceType
        );
        assert(tokenDataService, 'DummyTokenDataService not found');

        const solMint = 'So11111111111111111111111111111111111111112';
        console.log(`Fetching token data for SOL (${solMint})...`);

        const tokenData = await tokenDataService.getTokenDetails(solMint, 'solana');
        assert(tokenData, 'Should return token data');
        assert(tokenData.symbol, 'Should have symbol');
        assert(tokenData.name, 'Should have name');
        assert.equal(tokenData.decimals, 18, 'Should have decimals');
        assert(typeof tokenData.price === 'number', 'Should have price');

        console.log('Successfully fetched token data:', tokenData);
      },
    },
    {
      name: 'Scenario 9: Should test trending tokens',
      fn: async (runtime: IAgentRuntime) => {
        const tokenDataService = runtime.getService<DummyTokenDataService>(
          DummyTokenDataService.serviceType
        );
        assert(tokenDataService, 'DummyTokenDataService not found');

        console.log('Fetching trending tokens...');

        const trendingTokens = await tokenDataService.getTrendingTokens('solana', 5);
        assert(Array.isArray(trendingTokens), 'Should return array of trending tokens');
        assert.equal(trendingTokens.length, 5, 'Should return requested number of tokens');

        trendingTokens.forEach((token, i) => {
          assert(token.symbol, `Token ${i} should have symbol`);
          assert(token.name, `Token ${i} should have name`);
          assert(typeof token.price === 'number', `Token ${i} should have price`);
        });

        console.log('Successfully fetched trending tokens.');
      },
    },
    {
      name: 'Scenario 10: Integration test - LP service with custom pool configuration',
      fn: async (runtime: IAgentRuntime) => {
        const lpService = runtime.getService<DummyLpService>(ILpService.serviceType);
        assert(lpService, 'DummyLpService not found');

        // Test that we can work with both pools
        console.log('Testing integration with multiple pools...');

        // Get all pools
        const allPools = await lpService.getPools();
        assert.equal(allPools.length, 2, 'Should have 2 pools');

        // Test operations on each pool
        for (const pool of allPools) {
          console.log(`Testing operations on pool ${pool.id}...`);

          // Add liquidity
          const addResult = await lpService.addLiquidity({
            userVault: {} as any,
            poolId: pool.id,
            tokenAAmountLamports: '1000000000',
            slippageBps: 100,
          });
          assert.equal(addResult.success, true, `Add liquidity should succeed for ${pool.id}`);

          // Remove liquidity
          const removeResult = await lpService.removeLiquidity({
            userVault: {} as any,
            poolId: pool.id,
            lpTokenAmountLamports: '1000000',
            slippageBps: 50,
          });
          assert.equal(
            removeResult.success,
            true,
            `Remove liquidity should succeed for ${pool.id}`
          );
        }

        console.log('Successfully tested operations on all pools.');
      },
    },
    {
      name: 'Scenario 11: Should initialize wallet service and verify functionality',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing wallet service initialization...');

        // Check DummyWalletService
        const walletService = runtime.getService<DummyWalletService>(ServiceType.WALLET);
        assert(walletService, 'DummyWalletService not found in runtime');

        // Test initial balance
        const initialBalance = await walletService.getBalance('USDC');
        assert.equal(initialBalance, 10000, 'Should have initial USDC balance of 10000');

        console.log('Successfully verified wallet service is initialized.');
      },
    },
    {
      name: 'Scenario 12: Should test wallet operations',
      fn: async (runtime: IAgentRuntime) => {
        const walletService = runtime.getService<DummyWalletService>(ServiceType.WALLET);
        assert(walletService, 'DummyWalletService not found');

        console.log('Testing wallet operations...');

        // Add funds
        await walletService.addFunds('SOL', 5);
        const solBalance = await walletService.getBalance('SOL');
        assert.equal(solBalance, 5, 'Should have 5 SOL after adding funds');

        // Get portfolio
        const portfolio = await walletService.getPortfolio();
        assert(portfolio.totalValueUsd > 0, 'Portfolio should have positive total value');
        assert(Array.isArray(portfolio.assets), 'Portfolio should have assets array');
        assert(portfolio.assets.length >= 2, 'Portfolio should have at least 2 assets');

        // Find SOL in portfolio
        const solAsset = portfolio.assets.find((a) => a.symbol === 'SOL');
        assert(solAsset, 'SOL should be in portfolio');
        assert.equal(solAsset.balance, '5', 'SOL balance string should be "5"');

        console.log('Successfully tested wallet operations.');
      },
    },
    {
      name: 'Scenario 13: Should test SOL transfers',
      fn: async (runtime: IAgentRuntime) => {
        const walletService = runtime.getService<DummyWalletService>(ServiceType.WALLET);
        assert(walletService, 'DummyWalletService not found');

        console.log('Testing SOL transfer functionality...');

        // Reset wallet to ensure clean state
        await walletService.resetWallet(10000, 'USDC');

        // Add SOL to wallet
        await walletService.addFunds('SOL', 10);

        // Transfer some SOL
        const txHash = await walletService.transferSol('dummy-from', 'dummy-to', 3e9); // 3 SOL
        assert(txHash, 'Should return transaction hash');
        assert.match(txHash, /^dummy-tx-/, 'Transaction hash should have dummy prefix');

        // Check remaining balance
        const remainingBalance = await walletService.getBalance('SOL');
        assert.equal(remainingBalance, 7, 'Should have 7 SOL remaining after transfer');

        // Test insufficient balance
        try {
          await walletService.transferSol('dummy-from', 'dummy-to', 10e9); // 10 SOL
          assert.fail('Should throw error for insufficient balance');
        } catch (error: any) {
          assert.match(
            error.message,
            /Insufficient SOL balance/,
            'Should throw insufficient balance error'
          );
        }

        console.log('Successfully tested SOL transfers.');
      },
    },
  ],
};

export default dummyServicesScenariosSuite;
