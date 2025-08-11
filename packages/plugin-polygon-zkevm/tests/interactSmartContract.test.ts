import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { interactSmartContractAction } from '../src/actions/interactSmartContract';
import type { IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import * as llmHelpers from '../src/utils/llmHelpers';

// Mock ethers
vi.mock('ethers', () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => ({
    getNetwork: vi.fn().mockResolvedValue({ chainId: 1101 }),
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: BigInt('30000000000'),
      maxPriorityFeePerGas: BigInt('2000000000'),
      gasPrice: BigInt('20000000000'),
    }),
  })),
  Wallet: vi.fn().mockImplementation(() => ({
    getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    connect: vi.fn().mockReturnThis(),
  })),
  Contract: vi.fn().mockImplementation(() => ({
    transfer: Object.assign(
      vi.fn().mockResolvedValue({
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          gasUsed: BigInt(21000),
          blockNumber: 12345,
        }),
      }),
      {
        estimateGas: vi.fn().mockResolvedValue(BigInt(21000)),
      }
    ),
    mint: Object.assign(
      vi.fn().mockResolvedValue({
        hash: '0xdef4567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          gasUsed: BigInt(50000),
          blockNumber: 12346,
        }),
      }),
      {
        estimateGas: vi.fn().mockResolvedValue(BigInt(50000)),
      }
    ),
  })),
  parseEther: vi.fn().mockImplementation((value: string) => {
    const ethValue = parseFloat(value);
    return BigInt(Math.floor(ethValue * 1e18));
  }),
  parseUnits: vi.fn().mockImplementation((value: string, unit: string) => {
    if (unit === 'gwei') {
      return BigInt(Math.floor(parseFloat(value) * 1e9));
    }
    return BigInt(value);
  }),
  formatEther: vi.fn().mockImplementation((value: bigint) => {
    return (Number(value) / 1e18).toString();
  }),
  Interface: vi.fn().mockImplementation(() => ({})),
}));

// Mock LLM helpers
vi.mock('../src/utils/llmHelpers', () => ({
  callLLMWithTimeout: vi.fn(),
}));

const callLLMWithTimeoutMock = llmHelpers.callLLMWithTimeout as Mock;

describe('interactSmartContractAction', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntime = {
      getSetting: vi.fn().mockImplementation((key: string) => {
        switch (key) {
          case 'ALCHEMY_API_KEY':
            return 'test-alchemy-key';
          case 'ZKEVM_RPC_URL':
            return 'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          case 'PRIVATE_KEY':
            return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12';
          default:
            return undefined;
        }
      }),
    } as unknown as IAgentRuntime;

    mockMessage = {
      content: { text: 'test message' },
    } as Memory;

    mockState = {} as State;

    mockCallback = vi.fn();
  });

  describe('validate', () => {
    it('should return true when all required settings are present', async () => {
      const result = await interactSmartContractAction.validate(
        mockRuntime,
        mockMessage,
        mockState
      );
      expect(result).toBe(true);
    });

    it('should return false when PRIVATE_KEY is missing', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return undefined;
        return key === 'ALCHEMY_API_KEY' ? 'test-key' : 'test-url';
      });

      const result = await interactSmartContractAction.validate(
        mockRuntime,
        mockMessage,
        mockState
      );
      expect(result).toBe(false);
    });

    it('should return false when both ALCHEMY_API_KEY and ZKEVM_RPC_URL are missing', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-key';
        return undefined;
      });

      const result = await interactSmartContractAction.validate(
        mockRuntime,
        mockMessage,
        mockState
      );
      expect(result).toBe(false);
    });

    it('should return true when only ALCHEMY_API_KEY is present', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-key';
        if (key === 'ALCHEMY_API_KEY') return 'test-alchemy-key';
        return undefined;
      });

      const result = await interactSmartContractAction.validate(
        mockRuntime,
        mockMessage,
        mockState
      );
      expect(result).toBe(true);
    });

    it('should return true when only ZKEVM_RPC_URL is present', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-key';
        if (key === 'ZKEVM_RPC_URL') return 'test-rpc-url';
        return undefined;
      });

      const result = await interactSmartContractAction.validate(
        mockRuntime,
        mockMessage,
        mockState
      );
      expect(result).toBe(true);
    });
  });

  describe('handler', () => {
    it('should throw error when PRIVATE_KEY is missing', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return undefined;
        return 'test-value';
      });

      // Don't mock LLM for this test since it should fail before LLM call
      callLLMWithTimeoutMock.mockImplementation(() => {
        throw new Error('Should not reach LLM call');
      });

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('PRIVATE_KEY is required for contract interaction.');
    });

    it('should throw error when both API endpoints are missing', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-key';
        return undefined;
      });

      // Don't mock LLM for this test since it should fail before LLM call
      callLLMWithTimeoutMock.mockImplementation(() => {
        throw new Error('Should not reach LLM call');
      });

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.');
    });

    it('should throw error when LLM returns error', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        error: 'Contract parameters not found',
      });

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Contract parameters not found');
    });

    it('should throw error when contract address is invalid', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: 'invalid-address',
        abi: [],
        methodName: 'transfer',
      });

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Invalid contract address received from LLM');
    });

    it('should throw error when ABI is invalid', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: 'invalid-abi',
        methodName: 'transfer',
      });

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Invalid ABI received from LLM');
    });

    it('should throw error when method name is invalid', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [{ name: 'transfer', type: 'function' }],
        methodName: '',
      });

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Invalid method name received from LLM');
    });

    it('should successfully interact with contract using transfer method', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            name: 'transfer',
            outputs: [{ name: '', type: 'bool' }],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'transfer',
        args: ['0x1234567890123456789012345678901234567890', '1000000000000000000'],
      });

      const result = await interactSmartContractAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).text).toContain('Smart contract interaction successful');
      expect((result as any).text).toContain('0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7');
      expect((result as any).text).toContain('transfer');
      expect((result as any).data.transactionHash).toBe(
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
      );
      expect(mockCallback).toHaveBeenCalledWith(result);
    });

    it('should successfully interact with contract using mint method with ETH value', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [{ name: 'amount', type: 'uint256' }],
            name: 'mint',
            outputs: [],
            stateMutability: 'payable',
            type: 'function',
          },
        ],
        methodName: 'mint',
        args: ['100'],
        value: '0.1',
      });

      const result = await interactSmartContractAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).text).toContain('Smart contract interaction successful');
      expect((result as any).text).toContain('mint');
      expect((result as any).data.transactionHash).toBe(
        '0xdef4567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      );
    });

    it('should handle gas parameters correctly (EIP-1559)', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'mint',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'mint',
        args: [],
        maxFeePerGas: '30',
        maxPriorityFeePerGas: '2',
        gasLimit: '100000',
      });

      const result = await interactSmartContractAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).text).toContain('Smart contract interaction successful');
    });

    it('should handle gas parameters correctly (legacy)', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'mint',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'mint',
        args: [],
        gasPrice: '20',
        gasLimit: '100000',
      });

      const result = await interactSmartContractAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).text).toContain('Smart contract interaction successful');
    });

    it('should handle contract interaction failure', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'transfer',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'transfer',
        args: [],
      });

      // Mock the Contract constructor to return a contract with failing method
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        transfer: Object.assign(vi.fn().mockRejectedValue(new Error('Transaction failed')), {
          estimateGas: vi.fn().mockResolvedValue(BigInt(21000)),
        }),
      };
      (Contract as any).mockImplementation(() => mockContractInstance);

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Failed to interact with smart contract');
    });

    it('should handle method not found in ABI', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'mint',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'nonExistentMethod',
        args: [],
      });

      // Mock the Contract constructor to return a contract without the method
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        mint: vi.fn(),
        // nonExistentMethod is not defined
      };
      (Contract as any).mockImplementation(() => mockContractInstance);

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Failed to interact with smart contract');
    });

    it('should handle transaction revert', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'transfer',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'transfer',
        args: [],
      });

      // Mock the Contract constructor to return a contract with reverting transaction
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        transfer: Object.assign(
          vi.fn().mockResolvedValue({
            hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            wait: vi.fn().mockResolvedValue({
              status: 0, // Transaction reverted
              gasUsed: BigInt(21000),
              blockNumber: 12345,
            }),
          }),
          {
            estimateGas: vi.fn().mockResolvedValue(BigInt(21000)),
          }
        ),
      };
      (Contract as any).mockImplementation(() => mockContractInstance);

      await expect(
        interactSmartContractAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
      ).rejects.toThrow('Failed to interact with smart contract');
    });

    it('should use RPC URL when Alchemy API key is not available', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-key';
        if (key === 'ZKEVM_RPC_URL') return 'https://rpc.polygon-zkevm.gateway.fm';
        return undefined;
      });

      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'transfer',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'transfer',
        args: [],
      });

      // Reset the Contract mock to default behavior
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        transfer: Object.assign(
          vi.fn().mockResolvedValue({
            hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            wait: vi.fn().mockResolvedValue({
              status: 1,
              gasUsed: BigInt(21000),
              blockNumber: 12345,
            }),
          }),
          {
            estimateGas: vi.fn().mockResolvedValue(BigInt(21000)),
          }
        ),
      };
      (Contract as any).mockImplementation(() => mockContractInstance);

      const result = await interactSmartContractAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).text).toContain('Smart contract interaction successful');
      expect((result as any).data.method).toBe('rpc');
    });

    it('should set default args when not provided', async () => {
      callLLMWithTimeoutMock.mockResolvedValue({
        contractAddress: '0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b7',
        abi: [
          {
            inputs: [],
            name: 'mint',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        methodName: 'mint',
        // args not provided
      });

      // Reset the Contract mock to include mint method
      const { Contract } = await import('ethers');
      const mockContractInstance = {
        mint: Object.assign(
          vi.fn().mockResolvedValue({
            hash: '0xdef4567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            wait: vi.fn().mockResolvedValue({
              status: 1,
              gasUsed: BigInt(50000),
              blockNumber: 12346,
            }),
          }),
          {
            estimateGas: vi.fn().mockResolvedValue(BigInt(50000)),
          }
        ),
      };
      (Contract as any).mockImplementation(() => mockContractInstance);

      const result = await interactSmartContractAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        {},
        mockCallback
      );

      expect((result as any).text).toContain('Smart contract interaction successful');
      expect((result as any).data.args).toEqual([]);
    });
  });
});
