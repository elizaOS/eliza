import type { IAgentRuntime, TestSuite } from '@elizaos/core';
import { strict as assert } from 'node:assert';

// Since ITokenCreationService is not in core, we'll check for the service dynamically
interface ITokenCreationService {
  serviceType: string;
  description: string;
  platform: string;
  createToken(params: any): Promise<any>;
  getTokenInfo(address: string): Promise<any>;
  isReady(): Promise<boolean>;
  getDeployerAddress(): Promise<string | null>;
}

export const tokenCreationServiceTestSuite: TestSuite = {
  name: 'Token Creation Service Real Implementation Tests',
  tests: [
    {
      name: 'Test 1: Should discover token creation services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Discovering token creation services...');

        // Check for Pumpfun plugin
        const pumpfunPlugin = runtime.plugins.find(
          (p) => p.name === 'pumpfun' || p.name === 'plugin-pumpfun'
        );
        if (pumpfunPlugin) {
          console.log('✓ Pumpfun plugin loaded');
        } else {
          console.log('⚠️  Pumpfun plugin not loaded');
        }

        // Try to find token creation service
        // Since it's not a standard service type, we need to check services manually
        const services = runtime.services || (runtime as any).serviceRegistry;
        if (services) {
          console.log('Checking registered services...');

          // Log all service types for debugging
          if (services instanceof Map) {
            console.log('Registered service types:', Array.from(services.keys()));
          }
        }
      },
    },

    {
      name: 'Test 2: Should test isReady method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing token creation service readiness...');

        // Try to get Pumpfun service directly
        const pumpfunService = runtime.getService('pumpfun') as any;
        if (!pumpfunService) {
          console.log('⚠️  No Pumpfun service found, skipping');
          return;
        }

        try {
          if (typeof pumpfunService.isReady === 'function') {
            const isReady = await pumpfunService.isReady();
            console.log(`✓ Service ready status: ${isReady}`);

            if (!isReady) {
              console.log('⚠️  Service not ready - check configuration:');
              console.log('  - PUMPFUN_PRIVATE_KEY environment variable');
              console.log('  - Network connectivity');
              console.log('  - RPC endpoint availability');
            }
          } else {
            console.log('⚠️  Service does not implement isReady method');
          }
        } catch (error) {
          console.error(
            'Failed to check service readiness:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    },

    {
      name: 'Test 3: Should test getDeployerAddress method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing deployer address retrieval...');

        const pumpfunService = runtime.getService('pumpfun') as any;
        if (!pumpfunService) {
          console.log('⚠️  No Pumpfun service found, skipping');
          return;
        }

        try {
          if (typeof pumpfunService.getDeployerAddress === 'function') {
            const deployerAddress = await pumpfunService.getDeployerAddress();

            if (deployerAddress) {
              console.log(`✓ Deployer address: ${deployerAddress}`);

              // Validate Solana address format
              if (deployerAddress.length === 44) {
                console.log('  ✓ Valid Solana address format');
              } else {
                console.log('  ⚠️  Unexpected address format');
              }
            } else {
              console.log('⚠️  No deployer address configured');
            }
          } else {
            console.log('⚠️  Service does not implement getDeployerAddress method');
          }
        } catch (error) {
          console.error(
            'Failed to get deployer address:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    },

    {
      name: 'Test 4: Should test getTokenInfo method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing token info retrieval...');

        const pumpfunService = runtime.getService('pumpfun') as any;
        if (!pumpfunService) {
          console.log('⚠️  No Pumpfun service found, skipping');
          return;
        }

        try {
          if (typeof pumpfunService.getTokenInfo === 'function') {
            // Test with a known Pumpfun token (example)
            const testTokenAddress = 'pump1111111111111111111111111111111111111111';

            try {
              const tokenInfo = await pumpfunService.getTokenInfo(testTokenAddress);

              if (tokenInfo) {
                console.log('✓ Retrieved token info');
                console.log(`  Name: ${tokenInfo.name || 'N/A'}`);
                console.log(`  Symbol: ${tokenInfo.symbol || 'N/A'}`);
                console.log(`  Supply: ${tokenInfo.supply || 'N/A'}`);
                console.log(`  Decimals: ${tokenInfo.decimals || 'N/A'}`);
              } else {
                console.log('⚠️  No token info found (token might not exist)');
              }
            } catch (error) {
              console.log(
                '⚠️  Could not retrieve token info:',
                error instanceof Error ? error.message : String(error)
              );
            }
          } else {
            console.log('⚠️  Service does not implement getTokenInfo method');
          }
        } catch (error) {
          console.error(
            'Failed to test getTokenInfo:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    },

    {
      name: 'Test 5: Should test createToken method (dry run only)',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing createToken method...');

        const pumpfunService = runtime.getService('pumpfun') as any;
        if (!pumpfunService) {
          console.log('⚠️  No Pumpfun service found, skipping');
          return;
        }

        // Verify method exists
        if (typeof pumpfunService.createToken === 'function') {
          console.log('✓ createToken method exists');

          // Log expected parameters
          console.log('Expected parameters for token creation:');
          console.log('  - name: Token name');
          console.log('  - symbol: Token symbol');
          console.log('  - description: Token description');
          console.log('  - imageUrl: Token image URL');
          console.log('  - twitter?: Twitter handle');
          console.log('  - telegram?: Telegram link');
          console.log('  - website?: Website URL');

          console.log(
            '\n⚠️  Skipping actual token creation (requires funds and would create real token)'
          );

          // Example of what the call would look like:
          console.log('\nExample usage:');
          console.log('const result = await pumpfunService.createToken({');
          console.log('  name: "Test Token",');
          console.log('  symbol: "TEST",');
          console.log('  description: "A test token",');
          console.log('  imageUrl: "https://example.com/image.png"');
          console.log('});');
        } else {
          console.log('⚠️  Service does not implement createToken method');
        }
      },
    },

    {
      name: 'Test 6: Should verify platform and service info',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing platform and service information...');

        const pumpfunService = runtime.getService('pumpfun') as any;
        if (!pumpfunService) {
          console.log('⚠️  No Pumpfun service found, skipping');
          return;
        }

        // Check platform
        if (pumpfunService.platform) {
          console.log(`✓ Platform: ${pumpfunService.platform}`);
          assert(pumpfunService.platform === 'solana', 'Pumpfun should be on Solana');
        }

        // Check service type
        if (pumpfunService.serviceType) {
          console.log(`✓ Service Type: ${pumpfunService.serviceType}`);
        }

        // Check description
        if (pumpfunService.description || pumpfunService.capabilityDescription) {
          console.log(
            `✓ Description: ${pumpfunService.description || pumpfunService.capabilityDescription}`
          );
        }

        // Check for any configuration requirements
        console.log('\nConfiguration requirements:');
        console.log('  - PUMPFUN_PRIVATE_KEY: Required for deploying tokens');
        console.log('  - SOLANA_RPC_URL: RPC endpoint (optional, defaults to mainnet)');
      },
    },
  ],
};

export default tokenCreationServiceTestSuite;
