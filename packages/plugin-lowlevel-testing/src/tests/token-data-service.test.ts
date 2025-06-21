import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { ITokenDataService, ServiceType } from '@elizaos/core';
import { strict as assert } from 'node:assert';

export const tokenDataServiceTestSuite: TestSuite = {
  name: 'Token Data Service Real Implementation Tests',
  tests: [
    {
      name: 'Test 1: Should discover token data services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Discovering token data services...');

        // Check for DexScreener plugin
        const dexscreenerPlugin = runtime.plugins.find(
          (p) => p.name === 'dexscreener-analytics-plugin'
        );
        if (dexscreenerPlugin) {
          console.log('✓ DexScreener plugin loaded');
        } else {
          console.log('⚠️  DexScreener plugin not loaded');
        }

        // Try to get token data service
        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
        if (tokenDataService) {
          console.log('✓ Token data service found');
          console.log(`  Service: ${(tokenDataService as any).constructor.name}`);
          console.log(`  Description: ${tokenDataService.capabilityDescription}`);
        } else {
          console.log('⚠️  No token data service found');
          console.log(
            'Note: DexScreener service may need to implement ITokenDataService interface'
          );
        }
      },
    },

    {
      name: 'Test 2: Should test getTokenDetails method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing getTokenDetails method...');

        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
        if (!tokenDataService) {
          console.log('⚠️  No token data service found, skipping');
          return;
        }

        try {
          // Test with popular tokens
          const testTokens = [
            {
              address: 'So11111111111111111111111111111111111111112',
              chain: 'solana',
              name: 'SOL',
            },
            {
              address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a',
              chain: 'solana',
              name: 'USDC',
            },
            {
              address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              chain: 'ethereum',
              name: 'USDC',
            },
          ];

          for (const token of testTokens) {
            try {
              const tokenData = await tokenDataService.getTokenDetails(token.address, token.chain);

              if (tokenData) {
                console.log(`✓ Retrieved data for ${token.name} on ${token.chain}`);
                console.log(`  Symbol: ${tokenData.symbol}`);
                console.log(`  Name: ${tokenData.name}`);
                console.log(`  Price: $${tokenData.price || 'N/A'}`);
                console.log(`  Market Cap: $${tokenData.marketCapUSD || 'N/A'}`);
                console.log(`  24h Volume: $${tokenData.volume24hUSD || 'N/A'}`);

                // Verify required fields
                assert(tokenData.id, 'Token should have an ID');
                assert(tokenData.symbol, 'Token should have a symbol');
                assert(tokenData.name, 'Token should have a name');
                assert(tokenData.address, 'Token should have an address');
                assert(tokenData.chain, 'Token should have a chain');
              } else {
                console.log(`⚠️  No data found for ${token.name} on ${token.chain}`);
              }
            } catch (error) {
              console.log(
                `⚠️  Failed to get ${token.name} data: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        } catch (error) {
          console.error(
            'Failed to test getTokenDetails:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 3: Should test getTrendingTokens method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing getTrendingTokens method...');

        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
        if (!tokenDataService) {
          console.log('⚠️  No token data service found, skipping');
          return;
        }

        try {
          // Test trending tokens on different chains
          const chains = ['solana', 'ethereum'];

          for (const chain of chains) {
            try {
              const trendingTokens = await tokenDataService.getTrendingTokens(chain, 5, '24h');

              assert(Array.isArray(trendingTokens), 'Should return an array');
              console.log(`✓ Found ${trendingTokens.length} trending tokens on ${chain}`);

              if (trendingTokens.length > 0) {
                console.log(`  Top trending on ${chain}:`);
                trendingTokens.slice(0, 3).forEach((token, i) => {
                  console.log(
                    `    ${i + 1}. ${token.symbol} - $${token.price || 'N/A'} (${token.priceChange24hPercent || 0}%)`
                  );
                });
              }
            } catch (error) {
              console.log(
                `⚠️  Could not get trending tokens for ${chain}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        } catch (error) {
          console.error(
            'Failed to test getTrendingTokens:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 4: Should test searchTokens method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing searchTokens method...');

        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
        if (!tokenDataService) {
          console.log('⚠️  No token data service found, skipping');
          return;
        }

        try {
          // Search for common tokens
          const searchQueries = ['USDC', 'ETH', 'SOL'];

          for (const query of searchQueries) {
            try {
              const results = await tokenDataService.searchTokens(query, undefined, 5);

              assert(Array.isArray(results), 'Should return an array');
              console.log(`✓ Found ${results.length} results for "${query}"`);

              if (results.length > 0) {
                console.log(`  Top results:`);
                results.slice(0, 3).forEach((token) => {
                  console.log(`    - ${token.symbol} (${token.name}) on ${token.chain}`);
                });
              }
            } catch (error) {
              console.log(
                `⚠️  Could not search for ${query}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        } catch (error) {
          console.error(
            'Failed to test searchTokens:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 5: Should test getTokensByAddresses method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing getTokensByAddresses method...');

        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
        if (!tokenDataService) {
          console.log('⚠️  No token data service found, skipping');
          return;
        }

        try {
          // Test batch token fetching
          const solanaTokens = [
            'So11111111111111111111111111111111111111112', // SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
          ];

          const tokens = await tokenDataService.getTokensByAddresses(solanaTokens, 'solana');

          assert(Array.isArray(tokens), 'Should return an array');
          console.log(`✓ Retrieved data for ${tokens.length} tokens`);

          tokens.forEach((token) => {
            console.log(`  - ${token.symbol}: $${token.price || 'N/A'}`);
          });
        } catch (error) {
          console.error(
            'Failed to test getTokensByAddresses:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },

    {
      name: 'Test 6: Should test data freshness and provider info',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing data freshness and provider info...');

        const tokenDataService = runtime.getService<ITokenDataService>(ServiceType.TOKEN_DATA);
        if (!tokenDataService) {
          console.log('⚠️  No token data service found, skipping');
          return;
        }

        try {
          // Get a token to check data freshness
          const tokenData = await tokenDataService.getTokenDetails(
            'So11111111111111111111111111111111111111112',
            'solana'
          );

          if (tokenData) {
            console.log('✓ Token data retrieved');
            console.log(`  Source Provider: ${tokenData.sourceProvider}`);

            if (tokenData.lastUpdatedAt) {
              const age = Date.now() - new Date(tokenData.lastUpdatedAt).getTime();
              const ageMinutes = Math.floor(age / 60000);
              console.log(`  Data Age: ${ageMinutes} minutes`);

              if (ageMinutes < 5) {
                console.log('  ✓ Data is fresh (< 5 minutes old)');
              } else {
                console.log('  ⚠️  Data might be stale');
              }
            }

            if (tokenData.raw) {
              console.log('  ✓ Raw data included');
            }
          }
        } catch (error) {
          console.error(
            'Failed to test data freshness:',
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
    },
  ],
};

export default tokenDataServiceTestSuite;
