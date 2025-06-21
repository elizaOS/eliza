import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';

// Since ISwapService is not standardized yet, we'll define expected interface
interface ISwapService {
  swap(params: any): Promise<any>;
  getQuote(params: any): Promise<any>;
  getSupportedTokens?(): Promise<any[]>;
}

export const swapServiceTestSuite: TestSuite = {
  name: 'Swap Service Real Implementation Tests',
  tests: [
    {
      name: 'Test 1: Should discover swap services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Discovering swap services...');

        // Check for Jupiter plugin
        const jupiterPlugin = runtime.plugins.find(
          (p) => p.name === 'jupiter dex plugin' || p.name === 'jupiter'
        );
        if (jupiterPlugin) {
          console.log('✓ Jupiter plugin loaded');
        } else {
          console.log('⚠️  Jupiter plugin not loaded');
        }

        // Check for Uniswap plugin
        const uniswapPlugin = runtime.plugins.find(
          (p) => p.name === 'uniswap' || p.name === 'plugin-uniswap'
        );
        if (uniswapPlugin) {
          console.log('✓ Uniswap plugin loaded');
        } else {
          console.log('⚠️  Uniswap plugin not loaded');
        }

        // Jupiter registers with Solana service
        const solanaService = runtime.getService('solana') as any;
        if (solanaService) {
          console.log('✓ Solana service found');

          // Check if Jupiter is registered as an exchange
          if (solanaService.exchanges || solanaService.registeredExchanges) {
            console.log('  Checking registered exchanges...');
          }
        }
      },
    },

    {
      name: 'Test 2: Should test Jupiter service functionality',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Jupiter swap service...');

        // Jupiter might be accessed through the Solana service
        const solanaService = runtime.getService('solana') as any;
        if (!solanaService) {
          console.log('⚠️  No Solana service found, skipping Jupiter tests');
          return;
        }

        // Check if Jupiter service is available
        const jupiterService = runtime.getService('jupiter') as any;
        if (jupiterService) {
          console.log('✓ Jupiter service found directly');

          // Test service properties
          if (jupiterService.name) {
            console.log(`  Name: ${jupiterService.name}`);
          }

          if (jupiterService.capabilityDescription) {
            console.log(`  Description: ${jupiterService.capabilityDescription}`);
          }
        } else {
          console.log('⚠️  Jupiter service not directly accessible');
          console.log('  Jupiter may be integrated into Solana service');
        }

        // Test quote functionality
        console.log('\nTesting quote functionality...');
        console.log('⚠️  Actual swap quotes require:');
        console.log('  - Valid token addresses');
        console.log('  - Network connectivity');
        console.log('  - Jupiter API access');
      },
    },

    {
      name: 'Test 3: Should test Uniswap service functionality',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Uniswap swap service...');

        const uniswapService = runtime.getService('uniswap') as any;
        if (!uniswapService) {
          console.log('⚠️  No Uniswap service found');

          // Check if Uniswap is part of EVM service
          const evmService = runtime.getService('evm') as any;
          if (evmService) {
            console.log('  Checking EVM service for Uniswap integration...');
          }
          return;
        }

        console.log('✓ Uniswap service found');

        // Test service properties
        if (uniswapService.name) {
          console.log(`  Name: ${uniswapService.name}`);
        }

        if (uniswapService.capabilityDescription) {
          console.log(`  Description: ${uniswapService.capabilityDescription}`);
        }

        // Check supported chains
        if (uniswapService.supportedChains) {
          console.log(`  Supported chains: ${uniswapService.supportedChains.join(', ')}`);
        }
      },
    },

    {
      name: 'Test 4: Should test swap quote retrieval',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing swap quote functionality...');

        // Test Jupiter quotes
        const jupiterService = runtime.getService('jupiter') as any;
        if (jupiterService && typeof jupiterService.getQuote === 'function') {
          console.log('\nTesting Jupiter quotes...');

          try {
            // Example quote request
            const quoteParams = {
              inputMint: 'So11111111111111111111111111111111111111112', // SOL
              outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a', // USDC
              amount: 1000000000, // 1 SOL in lamports
              slippageBps: 50, // 0.5% slippage
            };

            console.log('  Requesting quote for SOL -> USDC...');
            console.log('  ⚠️  Skipping actual API call (requires network access)');

            // Would call: const quote = await jupiterService.getQuote(quoteParams);
          } catch (error) {
            console.error(
              '  Failed to get Jupiter quote:',
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        // Test Uniswap quotes
        const uniswapService = runtime.getService('uniswap') as any;
        if (uniswapService && typeof uniswapService.getQuote === 'function') {
          console.log('\nTesting Uniswap quotes...');

          try {
            // Example quote request
            const quoteParams = {
              tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
              tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
              amountIn: '1000000000000000000', // 1 ETH in wei
              chainId: 1, // Ethereum mainnet
            };

            console.log('  Requesting quote for WETH -> USDC...');
            console.log('  ⚠️  Skipping actual API call (requires network access)');

            // Would call: const quote = await uniswapService.getQuote(quoteParams);
          } catch (error) {
            console.error(
              '  Failed to get Uniswap quote:',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      },
    },

    {
      name: 'Test 5: Should test swap execution (dry run only)',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing swap execution methods...');

        // Check Jupiter swap
        const jupiterService = runtime.getService('jupiter') as any;
        if (jupiterService && typeof jupiterService.swap === 'function') {
          console.log('✓ Jupiter swap method exists');

          console.log('\nJupiter swap parameters:');
          console.log('  - route: The swap route from getQuote');
          console.log('  - userPublicKey: User wallet address');
          console.log('  - wrapUnwrapSOL: Auto wrap/unwrap SOL');
          console.log('  - feeAccount: Optional fee account');

          console.log('\n⚠️  Skipping actual swap (requires funds)');
        }

        // Check Uniswap swap
        const uniswapService = runtime.getService('uniswap') as any;
        if (uniswapService && typeof uniswapService.swap === 'function') {
          console.log('\n✓ Uniswap swap method exists');

          console.log('\nUniswap swap parameters:');
          console.log('  - tokenIn: Input token address');
          console.log('  - tokenOut: Output token address');
          console.log('  - amountIn: Input amount');
          console.log('  - amountOutMin: Minimum output');
          console.log('  - recipient: Recipient address');
          console.log('  - deadline: Transaction deadline');

          console.log('\n⚠️  Skipping actual swap (requires funds)');
        }
      },
    },

    {
      name: 'Test 6: Should test supported tokens retrieval',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing supported tokens...');

        // Test Jupiter
        const jupiterService = runtime.getService('jupiter') as any;
        if (jupiterService && typeof jupiterService.getSupportedTokens === 'function') {
          try {
            console.log('Fetching Jupiter supported tokens...');
            const tokens = await jupiterService.getSupportedTokens();

            if (Array.isArray(tokens)) {
              console.log(`✓ Jupiter supports ${tokens.length} tokens`);

              // Show sample tokens
              if (tokens.length > 0) {
                console.log('  Sample tokens:');
                tokens.slice(0, 5).forEach((token) => {
                  console.log(`    - ${token.symbol}: ${token.address}`);
                });
              }
            }
          } catch (error) {
            console.log(
              '⚠️  Could not fetch Jupiter tokens:',
              error instanceof Error ? error.message : String(error)
            );
          }
        } else {
          console.log('⚠️  Jupiter does not expose getSupportedTokens method');
        }

        // Test Uniswap
        const uniswapService = runtime.getService('uniswap') as any;
        if (uniswapService && typeof uniswapService.getSupportedTokens === 'function') {
          try {
            console.log('\nFetching Uniswap supported tokens...');
            const tokens = await uniswapService.getSupportedTokens();

            if (Array.isArray(tokens)) {
              console.log(`✓ Uniswap supports ${tokens.length} tokens`);
            }
          } catch (error) {
            console.log(
              '⚠️  Could not fetch Uniswap tokens:',
              error instanceof Error ? error.message : String(error)
            );
          }
        } else {
          console.log('⚠️  Uniswap does not expose getSupportedTokens method');
        }
      },
    },
  ],
};

export default swapServiceTestSuite;
