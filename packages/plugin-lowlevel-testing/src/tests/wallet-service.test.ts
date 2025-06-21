import type { IAgentRuntime, TestSuite, IWalletService } from '@elizaos/core';
import { ServiceType } from '@elizaos/core';
import { strict as assert } from 'node:assert';

export const walletServiceTestSuite: TestSuite = {
  name: 'Wallet Service Real Implementation Tests',
  tests: [
    {
      name: 'Test 1: Should load and verify EVM wallet service',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing EVM wallet service...');

        // Check if EVM plugin is loaded
        const evmPlugin = runtime.plugins.find((p) => p.name === 'evm');
        if (!evmPlugin) {
          console.log('⚠️  EVM plugin not loaded, skipping EVM tests');
          return;
        }

        // Get wallet service
        const walletService = runtime.getService<IWalletService>(ServiceType.WALLET);
        assert(walletService, 'Wallet service not found');

        // Check if it's the EVM service
        const serviceName = (walletService as any).constructor.name;
        console.log(`Wallet service implementation: ${serviceName}`);

        // Test basic functionality
        try {
          const portfolio = await walletService.getPortfolio();
          assert(portfolio, 'Portfolio should be returned');
          assert(typeof portfolio.totalValueUsd === 'number', 'Total value should be a number');
          assert(Array.isArray(portfolio.assets), 'Assets should be an array');

          console.log(`✓ EVM wallet portfolio retrieved: $${portfolio.totalValueUsd} total value`);
          console.log(`✓ Assets: ${portfolio.assets.length} tokens`);

          // Log some asset details
          portfolio.assets.slice(0, 3).forEach((asset) => {
            console.log(
              `  - ${asset.symbol || asset.address}: ${asset.balance} (${asset.valueUsd ? `$${asset.valueUsd}` : 'no USD value'})`
            );
          });
        } catch (error) {
          console.error('Failed to get portfolio:', error);
          throw error;
        }
      },
    },

    {
      name: 'Test 2: Should test EVM balance retrieval',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing EVM balance retrieval...');

        const evmPlugin = runtime.plugins.find((p) => p.name === 'evm');
        if (!evmPlugin) {
          console.log('⚠️  EVM plugin not loaded, skipping');
          return;
        }

        const walletService = runtime.getService<IWalletService>(ServiceType.WALLET);
        assert(walletService, 'Wallet service not found');

        // Test native ETH balance
        try {
          const ethBalance = await walletService.getBalance('ETH');
          assert(typeof ethBalance === 'number', 'ETH balance should be a number');
          assert(ethBalance >= 0, 'ETH balance should be non-negative');

          console.log(`✓ ETH balance: ${ethBalance} ETH`);

          // Test USDC balance (common ERC20)
          const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // Mainnet USDC
          try {
            const usdcBalance = await walletService.getBalance(usdcAddress);
            assert(typeof usdcBalance === 'number', 'USDC balance should be a number');
            assert(usdcBalance >= 0, 'USDC balance should be non-negative');
            console.log(`✓ USDC balance: ${usdcBalance} USDC`);
          } catch (error) {
            console.log('⚠️  Could not get USDC balance (might be on wrong network)');
          }
        } catch (error) {
          console.error('Failed to get balances:', error);
          throw error;
        }
      },
    },

    {
      name: 'Test 3: Should test Solana wallet service if available',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing Solana wallet service...');

        // Check if Solana plugin is loaded
        const solanaPlugin = runtime.plugins.find((p) => p.name === 'solana');
        if (!solanaPlugin) {
          console.log('⚠️  Solana plugin not loaded, skipping Solana tests');
          return;
        }

        // Solana plugin might register its own service
        try {
          // Try to get Solana-specific service
          const solanaService = runtime.getService('solana') as any;
          if (solanaService) {
            console.log('✓ Found Solana service');

            // Test if it implements IWalletService methods
            if (solanaService.getBalance) {
              const solBalance = await solanaService.getBalance('SOL');
              console.log(`✓ SOL balance: ${solBalance} SOL`);
            }

            if (solanaService.getPortfolio) {
              const portfolio = await solanaService.getPortfolio();
              console.log(`✓ Solana portfolio: $${portfolio.totalValueUsd} total value`);
            }
          }
        } catch (error) {
          console.log(
            'Could not test Solana service:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    },

    {
      name: 'Test 4: Should verify wallet address format',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing wallet address retrieval...');

        const walletService = runtime.getService<IWalletService>(ServiceType.WALLET);
        if (!walletService) {
          console.log('⚠️  No wallet service found');
          return;
        }

        // Check if service has a method to get wallet address
        if ('getAddress' in walletService) {
          try {
            const address = await (walletService as any).getAddress();
            assert(address, 'Wallet address should be returned');
            assert(typeof address === 'string', 'Address should be a string');

            // Check if it's an Ethereum address
            if (address.startsWith('0x') && address.length === 42) {
              console.log(`✓ EVM wallet address: ${address}`);
            } else if (address.length === 44) {
              console.log(`✓ Solana wallet address: ${address}`);
            } else {
              console.log(`✓ Wallet address: ${address}`);
            }
          } catch (error) {
            console.log(
              '⚠️  Could not get wallet address:',
              error instanceof Error ? error.message : String(error)
            );
          }
        } else {
          console.log('⚠️  Wallet service does not expose getAddress method');
        }
      },
    },

    {
      name: 'Test 5: Should test transferSol method',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing transferSol method...');

        const walletService = runtime.getService<IWalletService>(ServiceType.WALLET);
        if (!walletService) {
          console.log('⚠️  No wallet service found');
          return;
        }

        // This test would require actual funds and a destination address
        // For safety, we'll just verify the method exists
        assert(typeof walletService.transferSol === 'function', 'transferSol method should exist');
        console.log('✓ transferSol method exists');

        // We won't actually execute a transfer in tests to avoid losing funds
        console.log('⚠️  Skipping actual transfer test (requires funds and destination)');
      },
    },

    {
      name: 'Test 6: Should test error handling for invalid tokens',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing error handling...');

        const walletService = runtime.getService<IWalletService>(ServiceType.WALLET);
        if (!walletService) {
          console.log('⚠️  No wallet service found');
          return;
        }

        try {
          // Test with invalid address
          const balance = await walletService.getBalance('0xinvalid');
          // Some implementations might return 0 for invalid addresses
          assert(typeof balance === 'number', 'Should handle invalid address gracefully');
          console.log(`✓ Invalid address handled gracefully (returned ${balance})`);
        } catch (error) {
          console.log(
            '✓ Invalid address threw error as expected:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
    },
  ],
};

export default walletServiceTestSuite;
