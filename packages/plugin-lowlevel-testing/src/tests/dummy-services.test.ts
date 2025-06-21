import type {
  IAgentRuntime,
  TestSuite,
  IWalletService,
  ITokenDataService,
  ILpService,
} from '@elizaos/core';
import { ServiceType } from '@elizaos/core';
import { strict as assert } from 'node:assert';

// This TestSuite is designed to validate the implementations provided by `plugin-dummy-services`.
// It serves as a specification and a "report" for the engineer developing that plugin.
// Each test checks if a dummy service is correctly registered and returns data with the expected structure.

export const dummyServiceTestSuite: TestSuite = {
  name: 'Dummy Services Implementation Report & Tests',
  tests: [
    {
      name: 'Dummy Wallet Service: Should implement IWalletService',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Checking for Dummy Wallet Service...');
        const walletService = runtime.getService<IWalletService>(ServiceType.WALLET);

        assert(walletService, 'Dummy Wallet Service (IWalletService) not found.');
        console.log('✓ Dummy Wallet Service is registered.');

        // Test getPortfolio
        const portfolio = await walletService.getPortfolio();
        assert(portfolio, 'getPortfolio should return a portfolio object.');
        assert(
          typeof portfolio.totalValueUsd === 'number',
          'Portfolio totalValueUsd should be a number.'
        );
        assert(Array.isArray(portfolio.assets), 'Portfolio assets should be an array.');
        console.log('✓ getPortfolio returns a valid portfolio structure.');
        if (portfolio.assets.length > 0) {
          const asset = portfolio.assets[0];
          assert(asset.address, 'Asset should have an address.');
          assert(typeof asset.balance === 'string', 'Asset balance should be a string.');
          assert(typeof asset.decimals === 'number', 'Asset decimals should be a number.');
        }
        console.log('✓ Portfolio asset structure is valid.');

        // Test getBalance
        const balance = await walletService.getBalance('DUMMY_TOKEN');
        assert(typeof balance === 'number', 'getBalance should return a number.');
        console.log('✓ getBalance returns a valid balance.');

        // Test transferSol existence
        assert(typeof walletService.transferSol === 'function', 'transferSol method should exist.');
        console.log('✓ transferSol method exists.');
      },
    },

    {
      name: 'Dummy Token Data Service: Should implement ITokenDataService',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Checking for Dummy Token Data Service...');
        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);

        assert(tokenDataService, 'Dummy Token Data Service (ITokenDataService) not found.');
        console.log('✓ Dummy Token Data Service is registered.');

        // Test getTokenDetails
        const tokenDetails = await tokenDataService.getTokenDetails('DUMMY_ADDR', 'dummy-chain');
        assert(tokenDetails, 'getTokenDetails should return token data.');
        assert(tokenDetails.symbol, 'TokenData should have a symbol.');
        assert(tokenDetails.name, 'TokenData should have a name.');
        assert(tokenDataService.capabilityDescription, 'capabilityDescription should be present');
        console.log('✓ getTokenDetails returns valid TokenData structure.');

        // Test getTrendingTokens
        const trendingTokens = await tokenDataService.getTrendingTokens('dummy-chain');
        assert(Array.isArray(trendingTokens), 'getTrendingTokens should return an array.');
        console.log('✓ getTrendingTokens returns a valid array.');

        // Test searchTokens
        const searchResults = await tokenDataService.searchTokens('DUMMY');
        assert(Array.isArray(searchResults), 'searchTokens should return an array.');
        console.log('✓ searchTokens returns a valid array.');

        // Test getTokensByAddresses
        const batchResults = await tokenDataService.getTokensByAddresses(
          ['DUMMY_ADDR_1'],
          'dummy-chain'
        );
        assert(Array.isArray(batchResults), 'getTokensByAddresses should return an array.');
        console.log('✓ getTokensByAddresses returns a valid array.');
      },
    },

    {
      name: 'Dummy LP Service: Should implement ILpService',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Checking for Dummy LP Service...');
        // Note: The core type uses 'lp' not 'lp_pool'
        const lpService = runtime.getService<ILpService>('lp' as any);

        assert(lpService, 'Dummy LP Service (ILpService) not found.');
        console.log('✓ Dummy LP Service is registered.');

        // Test getDexName
        const dexName = lpService.getDexName();
        assert(
          typeof dexName === 'string' && dexName.length > 0,
          'getDexName should return a non-empty string.'
        );
        console.log(`✓ getDexName returns a valid name: ${dexName}`);

        // Test getPools
        const pools = await lpService.getPools();
        assert(Array.isArray(pools), 'getPools should return an array.');
        if (pools.length > 0) {
          const pool = pools[0];
          assert(pool.id, 'PoolInfo should have an id.');
          assert(pool.dex, 'PoolInfo should have a dex.');
          assert(pool.tokenA?.mint, 'PoolInfo tokenA must have a mint.');
          assert(pool.tokenB?.mint, 'PoolInfo tokenB must have a mint.');
        }
        console.log('✓ getPools returns a valid array of PoolInfo.');

        // Test getLpPositionDetails
        // Expect null for a dummy address, but the method must exist and not throw.
        const position = await lpService.getLpPositionDetails('DUMMY_USER', 'DUMMY_POOL');
        assert(
          position === null || typeof position === 'object',
          'getLpPositionDetails should return an object or null.'
        );
        console.log('✓ getLpPositionDetails executed successfully.');

        // Test method existence for actions
        assert(typeof lpService.addLiquidity === 'function', 'addLiquidity method should exist.');
        assert(
          typeof lpService.removeLiquidity === 'function',
          'removeLiquidity method should exist.'
        );
        console.log('✓ Liquidity action methods exist.');
      },
    },

    {
      name: 'Dummy Swap Service: Should provide a dummy swap service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Checking for Dummy Swap Service (e.g., Jupiter/Uniswap)...');
        const swapService = runtime.getService('swap') as any; // Changed from 'jupiter' to 'swap'

        assert(swapService, 'Dummy Swap Service (named "swap") not found.');
        console.log('✓ Dummy Swap Service is registered.');

        // Test getQuote
        assert(typeof swapService.getQuote === 'function', 'getQuote method should exist.');
        console.log('✓ getQuote method exists.');

        // Test swap
        assert(typeof swapService.swap === 'function', 'swap method should exist.');
        console.log('✓ swap method exists.');
      },
    },

    {
      name: 'Dummy Token Creation Service: Should provide a dummy token creation service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Checking for Dummy Token Creation Service (e.g., pumpfun)...');
        const creationService = runtime.getService('token-creation') as any; // Changed from 'pumpfun' to 'token-creation'

        assert(creationService, 'Dummy Token Creation Service (named "token-creation") not found.');
        console.log('✓ Dummy Token Creation Service is registered.');

        // Test key methods
        assert(
          typeof creationService.createToken === 'function',
          'createToken method should exist.'
        );
        assert(
          typeof creationService.getDeployerAddress === 'function',
          'getDeployerAddress method should exist.'
        );
        assert(
          typeof creationService.getTokenInfo === 'function',
          'getTokenInfo method should exist.'
        );
        console.log('✓ Key methods (createToken, getDeployerAddress, getTokenInfo) exist.');

        const address = await creationService.getDeployerAddress();
        assert(
          typeof address === 'string' || address === null,
          'getDeployerAddress must return a string or null.'
        );
        console.log('✓ getDeployerAddress returns a valid type.');
      },
    },

    {
      name: 'Dummy Messaging Services: Should provide dummy messaging services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Checking for Dummy Messaging Services (e.g., Discord/Twitter)...');

        const messageService = runtime.getService('message') as any; // Changed from 'discord' to 'message'
        assert(messageService, 'Dummy Message Service not found.');
        assert(
          typeof messageService.sendMessage === 'function',
          'Message sendMessage method should exist.'
        );
        console.log('✓ Dummy Message Service is registered and has sendMessage.');

        const postService = runtime.getService('post') as any; // Changed from 'twitter' to 'post'
        assert(postService, 'Dummy Post Service not found.');
        assert(
          typeof postService.postTweet === 'function' || typeof postService.post === 'function',
          'Post postTweet or post method should exist.'
        );
        console.log('✓ Dummy Post Service is registered and has post methods.');
      },
    },
  ],
};

export default dummyServiceTestSuite;
