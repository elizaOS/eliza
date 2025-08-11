import { describe, it, expect, beforeEach, vi } from 'vitest';
import { deploySmartContractAction } from '../src/actions/deploySmartContract';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// Mock the dependencies
vi.mock('ethers', () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    estimateGas: vi.fn().mockResolvedValue(BigInt('2000000')),
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: BigInt('20000000000'),
      maxPriorityFeePerGas: BigInt('2000000000'),
    }),
  })),
  Wallet: vi.fn().mockImplementation(() => ({
    sendTransaction: vi.fn().mockResolvedValue({
      hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      wait: vi.fn().mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
      }),
    }),
  })),
  parseEther: vi.fn().mockImplementation((value) => BigInt(value) * BigInt('1000000000000000000')),
  parseUnits: vi.fn().mockImplementation((value, unit) => {
    if (unit === 'gwei') {
      return BigInt(value) * BigInt('1000000000');
    }
    return BigInt(value);
  }),
}));

vi.mock('../src/utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn(),
}));

describe('deploySmartContract', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(() => {
    // Mock environment variables
    process.env.ALCHEMY_API_KEY = 'test-env-api-key';
    process.env.ZKEVM_RPC_URL = 'https://polygonzkevm-mainnet.g.alchemy.com/v2';
    process.env.PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    mockRuntime = {
      getSetting: vi.fn().mockImplementation((key: string) => {
        switch (key) {
          case 'ALCHEMY_API_KEY':
            return 'test-api-key';
          case 'ZKEVM_RPC_URL':
            return 'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          case 'PRIVATE_KEY':
            return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
          default:
            return undefined;
        }
      }),
    } as unknown as IAgentRuntime;

    mockMessage = {
      content: {
        text: 'deploy smart contract with bytecode 0x608060405234801561001057600080fd5b50...',
      },
    } as Memory;

    mockState = {} as State;
  });

  describe('validate', () => {
    it('should return true when all required settings are present', async () => {
      const result = await deploySmartContractAction.validate(mockRuntime, mockMessage, mockState);
      expect(result).toBe(true);
    });

    it('should return true when PRIVATE_KEY is missing but API keys are present', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        switch (key) {
          case 'ALCHEMY_API_KEY':
            return 'test-api-key';
          case 'ZKEVM_RPC_URL':
            return 'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          case 'PRIVATE_KEY':
            return undefined;
          default:
            return undefined;
        }
      });

      // Also clear environment variable
      delete process.env.PRIVATE_KEY;

      const result = await deploySmartContractAction.validate(mockRuntime, mockMessage, mockState);
      expect(result).toBe(true); // Should pass validation since API keys are present
    });

    it('should return false when both ALCHEMY_API_KEY and ZKEVM_RPC_URL are missing', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        switch (key) {
          case 'PRIVATE_KEY':
            return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
          default:
            return undefined;
        }
      });

      // Also clear environment variables
      delete process.env.ALCHEMY_API_KEY;
      delete process.env.ZKEVM_RPC_URL;

      // Update message to contain deployment keywords
      const testMessage = {
        content: {
          text: 'deploy smart contract with bytecode 0x608060405234801561001057600080fd5b50...',
        },
      } as Memory;

      const result = await deploySmartContractAction.validate(mockRuntime, testMessage, mockState);
      expect(result).toBe(false);
    });

    it('should return true when using environment variables as fallback', async () => {
      // Mock runtime to return undefined (no settings)
      mockRuntime.getSetting = vi.fn().mockReturnValue(undefined);

      // Ensure environment variables are set
      process.env.ALCHEMY_API_KEY = 'test-env-api-key';
      process.env.PRIVATE_KEY =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      const result = await deploySmartContractAction.validate(mockRuntime, mockMessage, mockState);
      expect(result).toBe(true);
    });

    it('should return false when message does not contain deployment keywords', async () => {
      // Create a message without deployment keywords
      const nonDeploymentMessage = {
        content: {
          text: 'What is the weather today?',
        },
      } as Memory;

      const result = await deploySmartContractAction.validate(
        mockRuntime,
        nonDeploymentMessage,
        mockState
      );
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should have correct action properties', () => {
      expect(deploySmartContractAction.name).toBe('DEPLOY_SMART_CONTRACT');
      expect(deploySmartContractAction.similes).toContain('DEPLOY_CONTRACT');
      expect(deploySmartContractAction.similes).toContain('DEPLOY_ZKEVM_CONTRACT');
      expect(deploySmartContractAction.similes).toContain('CREATE_CONTRACT');
      expect(deploySmartContractAction.description).toContain(
        'Deploys a smart contract to Polygon zkEVM'
      );
    });

    it('should have examples', () => {
      expect(deploySmartContractAction.examples).toBeDefined();
      expect(deploySmartContractAction.examples).not.toBeNull();
      expect(Array.isArray(deploySmartContractAction.examples)).toBe(true);
      expect(deploySmartContractAction.examples!.length).toBeGreaterThan(0);
    });
  });
});
