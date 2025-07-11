import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CrossChainService } from '../../services/CrossChainService';
import { WalletService } from '../../services/WalletService';
import { elizaLogger } from '@elizaos/core';
import { nearPlugin } from '../../index';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Use the same TestRuntime from StorageService test
class TestRuntime {
  agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  character = {
    name: 'TestAgent',
    bio: ['Test agent for cross-chain service'],
    system: 'Test system',
    modelProvider: 'openai' as any,
    lore: [],
    messageExamples: [],
    postExamples: [],
    topics: [],
    style: {},
  };
  providers: any[] = [];
  actions: any[] = [];
  evaluators: any[] = [];
  plugins: any[] = [];
  services = new Map();

  async initialize(): Promise<void> {
    await this.registerPlugin(nearPlugin);
  }

  async registerPlugin(plugin: any): Promise<void> {
    this.plugins.push(plugin);

    if (plugin.services) {
      for (const ServiceClass of plugin.services) {
        try {
          const service = await (ServiceClass as any).start(this);
          this.services.set((ServiceClass as any).serviceName, service);
        } catch (error) {
          elizaLogger.error(`Failed to start service ${(ServiceClass as any).serviceName}:`, error);
        }
      }
    }

    if (plugin.actions) {
      this.actions.push(...plugin.actions);
    }
    if (plugin.providers) {
      this.providers.push(...plugin.providers);
    }
    if (plugin.evaluators) {
      this.evaluators.push(...plugin.evaluators);
    }
  }

  getService<T>(name: string): T | null {
    return (this.services.get(name) as T) || null;
  }

  getSetting(key: string): string | null {
    return process.env[key] || null;
  }

  // Implement other required methods
  async processMessage(message: any): Promise<void> {}
  async evaluate(message: any, state?: any): Promise<any[]> {
    return [];
  }
  async composeState(message: any): Promise<any> {
    return {
      values: {},
      data: {},
      text: '',
      bio: '',
      lore: '',
      messageDirections: '',
      postDirections: '',
      agentId: this.agentId,
      roomId: message.roomId,
      userId: message.userId,
    };
  }

  messageManager = {
    createMemory: async () => ({ id: uuidv4() as any }),
    getMemories: async () => [],
    getMemoriesByRoomIds: async () => [],
  };

  async stop(): Promise<void> {
    for (const [name, service] of this.services) {
      try {
        await (service as any).stop();
      } catch (error) {
        elizaLogger.error(`Error stopping service ${name}:`, error);
      }
    }
  }
}

describe('CrossChainService Integration Tests', () => {
  let runtime: TestRuntime;
  let crossChainService: CrossChainService;
  let walletService: WalletService;

  beforeEach(async () => {
    // Skip if no test credentials
    if (!process.env.NEAR_WALLET_SECRET_KEY || !process.env.NEAR_ADDRESS) {
      console.log('Skipping integration tests - no NEAR credentials provided');
      return;
    }

    runtime = new TestRuntime();
    await runtime.initialize();

    walletService = runtime.getService<WalletService>('near-wallet' as any)!;
    crossChainService = runtime.getService<CrossChainService>('near-crosschain' as any)!;

    expect(walletService).toBeDefined();
    expect(crossChainService).toBeDefined();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop();
    }
  });

  it('should initialize cross-chain service', async () => {
    if (!crossChainService) {
      return;
    }

    expect(crossChainService).toBeDefined();
    expect(crossChainService.capabilityDescription).toContain('Aurora');
  });

  it('should get supported chains', async () => {
    if (!crossChainService) {
      return;
    }

    const chains = await crossChainService.getSupportedChains();
    expect(chains).toContain('ethereum');
    expect(chains).toContain('aurora');
  });

  it('should estimate bridge fees', async () => {
    if (!crossChainService) {
      return;
    }

    // Test NEAR to Ethereum fee
    const ethFee = await crossChainService.estimateBridgeFee('near', 'ethereum', 'NEAR', '1');
    expect(ethFee).toBe('0.01'); // 0.01 NEAR for Rainbow Bridge

    // Test NEAR to Aurora fee
    const auroraFee = await crossChainService.estimateBridgeFee('near', 'aurora', 'NEAR', '1');
    expect(auroraFee).toBe('0.001'); // 0.001 NEAR for Aurora transfer
  });

  it('should handle unsupported bridge routes', async () => {
    if (!crossChainService) {
      return;
    }

    await expect(
      crossChainService.estimateBridgeFee('bitcoin', 'solana', 'BTC', '1')
    ).rejects.toThrow('Unsupported bridge route');
  });

  it('should get bridge status', async () => {
    if (!crossChainService) {
      return;
    }

    const status = await crossChainService.getBridgeStatus('fake-tx-hash');
    expect(status.status).toBe('pending');
    expect(status.details).toBeDefined();
  });

  // NOTE: The following tests would require actual funds and network interaction
  // They are commented out but show what real integration tests would look like

  /*
  it('should transfer NEAR to Aurora', async () => {
    if (!crossChainService) return;

    // This would require actual NEAR tokens
    const txHash = await crossChainService.transferToAurora(
      'NEAR',
      '0.001',
      '0x742d35Cc6634C0532925a3b844Bc9e7595f8f123' // Example Aurora address
    );

    expect(txHash).toBeDefined();
    expect(txHash).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('should bridge tokens to Ethereum', async () => {
    if (!crossChainService) return;

    // This would require actual tokens and bridge fee
    const txHash = await crossChainService.bridgeToEthereum(
      'wrap.testnet', // Wrapped NEAR
      '0.1',
      '0x742d35Cc6634C0532925a3b844Bc9e7595f8f123' // Example Ethereum address
    );

    expect(txHash).toBeDefined();
    expect(txHash).toMatch(/^[A-Za-z0-9]+$/);
  });
  */

  it('should handle transfer errors gracefully', async () => {
    if (!crossChainService) {
      return;
    }

    // Try to transfer with invalid parameters
    await expect(
      crossChainService.transferToAurora('INVALID_TOKEN', '0', 'invalid-address')
    ).rejects.toThrow();
  });

  it('should handle bridge errors gracefully', async () => {
    if (!crossChainService) {
      return;
    }

    // Try to bridge with invalid parameters
    await expect(
      crossChainService.bridgeToEthereum('invalid.token', '-1', 'not-an-eth-address')
    ).rejects.toThrow();
  });
});
