import { describe, expect, it } from 'vitest';
import { nearPlugin } from '../../index';
import type { Plugin, IAgentRuntime, Memory } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Create a test agent configuration
const testCharacter = {
  name: 'NEAR Test Agent',
  bio: ['A test agent for NEAR Protocol integration testing'],
  lore: ['Created to test NEAR blockchain capabilities'],
  messageExamples: [],
  postExamples: [],
  topics: ['blockchain', 'NEAR', 'crypto', 'DeFi'],
  style: {
    all: ['professional', 'helpful', 'knowledgeable about NEAR'],
  },
  system:
    'You are a NEAR Protocol expert agent capable of managing wallets, executing transactions, and interacting with smart contracts.',
  modelProvider: 'openai' as any,
  plugins: [nearPlugin.name],
  settings: {
    secrets: {},
    voice: {
      model: 'en_US-hfc_female-medium',
    },
  },
};

describe('NEAR Plugin E2E Tests', () => {
  it('should properly export the plugin with all required components', () => {
    expect(nearPlugin).toBeDefined();
    expect(nearPlugin.name).toBe('near');
    expect(nearPlugin.description).toContain('NEAR Protocol');

    // Check services
    expect(nearPlugin.services).toBeDefined();
    expect(nearPlugin.services?.length).toBeGreaterThan(0);

    // Check actions
    expect(nearPlugin.actions).toBeDefined();
    expect(nearPlugin.actions?.length).toBeGreaterThan(0);

    // Check providers
    expect(nearPlugin.providers).toBeDefined();
    expect(nearPlugin.providers?.length).toBeGreaterThan(0);
  });

  it('should have proper action configurations', () => {
    const actionNames = nearPlugin.actions?.map((a) => a.name) || [];

    // Check core actions exist
    expect(actionNames).toContain('SEND_NEAR');
    expect(actionNames).toContain('EXECUTE_SWAP_NEAR');
    expect(actionNames).toContain('SAVE_MEMORY');
    expect(actionNames).toContain('RETRIEVE_MEMORY');
    expect(actionNames).toContain('CROSS_CHAIN_TRANSFER');

    // Check action structure
    nearPlugin.actions?.forEach((action) => {
      expect(action.name).toBeDefined();
      expect(action.description).toBeDefined();
      expect(action.handler).toBeDefined();
      expect(action.validate).toBeDefined();
      expect(action.examples).toBeDefined();
      expect(Array.isArray(action.examples)).toBe(true);
    });
  });

  it('should have proper service configurations', () => {
    const serviceNames = nearPlugin.services?.map((s) => (s as any).serviceName) || [];

    // Check core services exist
    expect(serviceNames).toContain('near-wallet');
    expect(serviceNames).toContain('near-transaction');
    expect(serviceNames).toContain('near-swap');
    expect(serviceNames).toContain('near-storage');
    expect(serviceNames).toContain('near-crosschain');
    expect(serviceNames).toContain('near-marketplace');
    expect(serviceNames).toContain('near-game');

    // Check service structure
    nearPlugin.services?.forEach((ServiceClass) => {
      expect((ServiceClass as any).serviceName).toBeDefined();
      expect((ServiceClass as any).start).toBeDefined();
      expect(typeof ServiceClass).toBe('function');
    });
  });

  it('should have wallet provider', () => {
    const providers = nearPlugin.providers || [];
    expect(providers.length).toBeGreaterThan(0);

    // Check that we have at least one provider with a get method
    const hasValidProvider = providers.some((p) => typeof p.get === 'function');
    expect(hasValidProvider).toBe(true);
  });

  // Test character configuration compatibility
  it('should work with test character configuration', () => {
    expect(testCharacter.plugins).toContain(nearPlugin.name);
    expect(testCharacter.system).toContain('NEAR Protocol');
  });
});

// Integration test suite that would run with real runtime
export class NearPluginTestSuite {
  name = 'near-plugin-integration';
  description = 'E2E tests for NEAR plugin functionality';

  tests = [
    {
      name: 'Plugin initializes with all services',
      fn: async (runtime: IAgentRuntime) => {
        // Check wallet service
        const walletService = runtime.getService('near-wallet' as any);
        if (!walletService) {
          throw new Error('Wallet service not initialized');
        }

        // Check transaction service
        const txService = runtime.getService('near-transaction' as any);
        if (!txService) {
          throw new Error('Transaction service not initialized');
        }

        // Check storage service
        const storageService = runtime.getService('near-storage' as any);
        if (!storageService) {
          throw new Error('Storage service not initialized');
        }

        console.log('✅ All NEAR services initialized successfully');
      },
    },
    {
      name: 'Wallet provider returns account info',
      fn: async (runtime: IAgentRuntime) => {
        // Check that we have a provider registered
        if (!runtime.providers || runtime.providers.length === 0) {
          throw new Error('No providers registered');
        }

        const memory: Memory = {
          id: uuidv4() as any,
          userId: uuidv4() as any,
          roomId: uuidv4() as any,
          agentId: runtime.agentId,
          content: { text: 'Check wallet', source: 'test' },
          createdAt: Date.now(),
        };

        const state = await runtime.composeState(memory);

        // Get the first provider (our wallet provider)
        const walletProvider = runtime.providers[0];
        const result = await walletProvider.get(runtime, memory, state);

        if (!result) {
          throw new Error('Provider returned no result');
        }

        // Check if the result contains wallet-related information
        const resultText = typeof result === 'string' ? result : result.text || '';
        if (
          !resultText.includes('NEAR') &&
          !resultText.includes('wallet') &&
          !resultText.includes('Account')
        ) {
          throw new Error('Provider response missing expected wallet content');
        }

        console.log('✅ Wallet provider working correctly');
      },
    },
    {
      name: 'Storage actions are available',
      fn: async (runtime: IAgentRuntime) => {
        const saveAction = runtime.actions.find((a) => a.name === 'SAVE_MEMORY');
        const retrieveAction = runtime.actions.find((a) => a.name === 'RETRIEVE_MEMORY');

        if (!saveAction || !retrieveAction) {
          throw new Error('Storage actions not found');
        }

        // Test validation
        const memory: Memory = {
          id: uuidv4() as any,
          userId: uuidv4() as any,
          roomId: uuidv4() as any,
          agentId: runtime.agentId,
          content: { text: 'Remember this test data', source: 'test' },
          createdAt: Date.now(),
        };

        const isValid = await saveAction.validate(runtime, memory);
        if (!isValid) {
          throw new Error('Save memory validation failed for valid input');
        }

        console.log('✅ Storage actions available and validating correctly');
      },
    },
    {
      name: 'Cross-chain service supports Aurora and Ethereum',
      fn: async (runtime: IAgentRuntime) => {
        const crossChainService = runtime.getService('near-crosschain' as any);
        if (!crossChainService) {
          throw new Error('Cross-chain service not found');
        }

        const supportedChains = await (crossChainService as any).getSupportedChains();
        if (!supportedChains.includes('ethereum') || !supportedChains.includes('aurora')) {
          throw new Error('Expected chains not supported');
        }

        // Test fee estimation
        const fee = await (crossChainService as any).estimateBridgeFee(
          'near',
          'ethereum',
          'NEAR',
          '1'
        );

        if (!fee || parseFloat(fee) <= 0) {
          throw new Error('Invalid bridge fee estimate');
        }

        console.log('✅ Cross-chain service working with Aurora/Ethereum support');
      },
    },
    {
      name: 'Marketplace service can browse jobs',
      fn: async (runtime: IAgentRuntime) => {
        const marketplaceService = runtime.getService('near-marketplace' as any);
        if (!marketplaceService) {
          throw new Error('Marketplace service not found');
        }

        // Browse available jobs
        const jobs = await (marketplaceService as any).browseJobs();

        // Should return array (empty or with jobs)
        if (!Array.isArray(jobs)) {
          throw new Error('Browse jobs did not return an array');
        }

        console.log(`✅ Marketplace service found ${jobs.length} jobs`);
      },
    },
    {
      name: 'Game service can list active games',
      fn: async (runtime: IAgentRuntime) => {
        const gameService = runtime.getService('near-game' as any);
        if (!gameService) {
          throw new Error('Game service not found');
        }

        // Get active games
        const games = await (gameService as any).getActiveGames();

        if (!Array.isArray(games)) {
          throw new Error('Get active games did not return an array');
        }

        console.log(`✅ Game service found ${games.length} active games`);
      },
    },
  ];
}

// Export the test suite for the ElizaOS test runner
export default new NearPluginTestSuite();
