import { describe, it, expect, vi, beforeEach, type Mock, type Mocked } from 'vitest';
import { PolygonRpcService } from '../PolygonRpcService';
import type { IAgentRuntime } from '@elizaos/core';
// Import the specific ethers components that will be mocked or used for type information.

import { Contract, JsonRpcProvider, Wallet, type ContractRunner } from 'ethers';
import type * as ethersActualTypes from 'ethers'; // For type hints if needed for actualEthers

// Define a simple interface for our mocked provider instance
interface MockEthersProvider {
  getNetwork: Mock;
}

// Define a simple interface for our mocked signer instance
interface MockEthersSigner {
  getAddress: Mock;
  connect: Mock;
}

// --- Mock implementations for specific contract methods ---
// These are defined globally so they can be accessed within the vi.doMock factory
// and reset in beforeEach.
const mockGetLastChildBlock = vi.fn();
const mockCheckpointManagerAddressFn = vi.fn();
const mockCurrentEpoch = vi.fn(); // For StakeManager initialization during PolygonRpcService.start

// --- Constants used by mocks and tests ---
const ROOT_CHAIN_MANAGER_ADDRESS_L1 = '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77';
const STAKE_MANAGER_ADDRESS_L1 = '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908';
const mockCheckpointManagerAddr = '0xCheckpointManager123';
const mockL1RpcUrl = 'http://mock-l1-rpc.com';
const mockL2RpcUrl = 'http://mock-l2-rpc.com';
const mockPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

// --- Mock @elizaos/core logger ---
vi.mock('@elizaos/core', async () => {
  const actualCore = await vi.importActual<typeof import('@elizaos/core')>('@elizaos/core');
  return {
    ...actualCore,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

// --- Mock the entire ethers module ---
vi.mock('ethers', async () => {
  const actualEthers = await vi.importActual<typeof ethersActualTypes>('ethers');
  return {
    ...actualEthers, // Preserve all other exports from ethers (types, utils, etc.)
    JsonRpcProvider: vi
      .fn()
      .mockImplementation((url: string, network?: unknown, options?: unknown) => ({
        // Mock instance methods of JsonRpcProvider that are called by PolygonRpcService
        getNetwork: vi.fn().mockResolvedValue({ chainId: 1n }),
        // Add other methods like getBlockNumber, getBalance, etc., if they were directly called
        // on the provider instance *during initialization* (not through a Contract instance).
      })),
    Wallet: vi.fn().mockImplementation((privateKey: string, provider?: ContractRunner) => ({
      // Mock instance methods of Wallet
      getAddress: vi.fn().mockResolvedValue('0xMockSignerAddress'),
      connect: vi.fn().mockReturnThis(), // Common for chaining or connecting to a provider
    })),
    Contract: vi
      .fn()
      .mockImplementation((address: string, abi: unknown, runner?: ContractRunner) => {
        // This mock constructor returns an object that mocks a Contract instance.
        // Logic to return different mocks based on contract address:
        if (address === ROOT_CHAIN_MANAGER_ADDRESS_L1) {
          return {
            checkpointManagerAddress: mockCheckpointManagerAddressFn,
            connect: vi.fn().mockReturnThis(),
            // target: address, // for ethers v6 compatibility if needed by mock instance
          };
        }
        if (address === mockCheckpointManagerAddr) {
          return {
            getLastChildBlock: mockGetLastChildBlock,
            connect: vi.fn().mockReturnThis(),
            // target: address,
          };
        }
        if (address === STAKE_MANAGER_ADDRESS_L1) {
          return {
            currentEpoch: mockCurrentEpoch, // Used in PolygonRpcService.initializeProviders
            connect: vi.fn().mockReturnThis(),
            // target: address,
          };
        }
        // Fallback for any other contract address, returning a generic mock contract instance
        return {
          connect: vi.fn().mockReturnThis(),
          getAddress: vi.fn().mockResolvedValue(address), // Example generic method
          // target: address,
        };
      }),
  };
});

// --- Test Suite ---
describe('PolygonRpcService Unit Tests', () => {
  let service: PolygonRpcService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // 1. Clear all mocks (including call history for vi.fn() instances from vi.doMock)
    vi.clearAllMocks();

    // 2. Reset the state/return values of our specific mock functions
    mockGetLastChildBlock.mockReset().mockResolvedValue(1000n);
    mockCheckpointManagerAddressFn.mockReset().mockResolvedValue(mockCheckpointManagerAddr);
    mockCurrentEpoch.mockReset().mockResolvedValue(1n); // For StakeManager init

    // 3. Reset the main ethers constructor mocks themselves (the vi.fn() instances from vi.doMock)
    // This ensures that checks like `toHaveBeenCalledWith` are clean for each test.
    // These are now the vi.fn() instances from the vi.doMock factory because of the top-level static imports.
    // (JsonRpcProvider as Mock).mockClear(); // REMOVED
    // (Wallet as Mock).mockClear(); // REMOVED
    // (Contract as Mock).mockClear(); // REMOVED

    // 4. Set up mockRuntime for each test
    mockRuntime = {
      getSetting: vi.fn((key: string): string | undefined => {
        if (key === 'ETHEREUM_RPC_URL') return mockL1RpcUrl;
        if (key === 'POLYGON_RPC_URL') return mockL2RpcUrl;
        if (key === 'PRIVATE_KEY') return mockPrivateKey;
        return undefined;
      }),
      getService: vi.fn(), // Mock getService if PolygonRpcService uses it
    } as unknown as IAgentRuntime;
  });

  // --- Tests for PolygonRpcService.start (Initialization) ---
  describe('PolygonRpcService.start (initialization)', () => {
    it('should initialize providers and contracts correctly', async () => {
      service = await PolygonRpcService.start(mockRuntime);

      expect(mockRuntime.getSetting).toHaveBeenCalledWith('ETHEREUM_RPC_URL');
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('POLYGON_RPC_URL');
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('PRIVATE_KEY');

      // Check that ethers constructors were called
      expect(JsonRpcProvider).toHaveBeenCalledWith(mockL1RpcUrl);
      expect(JsonRpcProvider).toHaveBeenCalledWith(mockL2RpcUrl);
      // const l1ProviderInstance = (JsonRpcProvider as unknown as Mock).mock.instances[0]; // REMOVED
      // console.log('l1ProviderInstance in test:', l1ProviderInstance); // REMOVED DEBUGGING LINE

      // New assertion for Wallet call
      expect(Wallet).toHaveBeenCalledTimes(1);
      const walletCallArgs = (Wallet as unknown as Mock).mock.calls[0];
      expect(walletCallArgs[0]).toBe(mockPrivateKey);
      expect(walletCallArgs[1]).toBeInstanceOf(Object); // New structural check
      expect(walletCallArgs[1]).toHaveProperty('getNetwork'); // New structural check
      expect(typeof (walletCallArgs[1] as MockEthersProvider).getNetwork).toBe('function'); // Used MockEthersProvider

      const signerInstanceL1 = (Wallet as unknown as Mock).mock.instances[0];
      // console.log('signerInstanceL1 in test:', signerInstanceL1); // Keep commented for now

      // Check StakeManager contract instantiation (uses L1 provider for reads initially)
      expect(Contract).toHaveBeenCalledWith(
        STAKE_MANAGER_ADDRESS_L1,
        expect.any(Object), // StakeManagerABI
        walletCallArgs[1] // Use the actual provider instance passed to Wallet
      );
      // Check mockCurrentEpoch was called on the StakeManager instance from initializeProviders
      // This requires currentEpoch() to be part of the mocked StakeManager instance
      expect(mockCurrentEpoch).not.toHaveBeenCalled();

      // Check RootChainManager contract instantiation (uses L1 signer)
      expect(Contract).toHaveBeenCalledWith(
        ROOT_CHAIN_MANAGER_ADDRESS_L1,
        expect.any(Object), // RootChainManagerABI
        expect.objectContaining<Partial<MockEthersSigner>>({
          // Check for shape of signer
          getAddress: expect.any(Function),
          connect: expect.any(Function),
        })
      );

      // Check checkpointManagerAddress was called on the RootChainManager instance
      expect(mockCheckpointManagerAddressFn).toHaveBeenCalled();

      // Check CheckpointManager contract instantiation (uses L1 provider)
      expect(Contract).toHaveBeenCalledWith(
        mockCheckpointManagerAddr,
        expect.any(Object), // CheckpointManagerABI
        walletCallArgs[1] // Use the actual provider instance passed to Wallet
      );

      expect(service).toBeInstanceOf(PolygonRpcService);
    });

    it('should throw if ETHEREUM_RPC_URL is missing', async () => {
      vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return mockL2RpcUrl;
        if (key === 'PRIVATE_KEY') return mockPrivateKey;
        return undefined;
      });
      await expect(PolygonRpcService.start(mockRuntime)).rejects.toThrow('Missing L1/L2 RPC URLs');
    });

    it('should throw if PRIVATE_KEY is missing', async () => {
      vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
        if (key === 'ETHEREUM_RPC_URL') return mockL1RpcUrl;
        if (key === 'POLYGON_RPC_URL') return mockL2RpcUrl;
        return undefined; // PRIVATE_KEY is missing
      });
      await expect(PolygonRpcService.start(mockRuntime)).rejects.toThrow(
        'Missing PRIVATE_KEY for signer initialization'
      );
    });

    it('should throw if RootChainManager.checkpointManagerAddress fails', async () => {
      mockCheckpointManagerAddressFn.mockRejectedValueOnce(new Error('RCM call failed'));
      await expect(PolygonRpcService.start(mockRuntime)).rejects.toThrow(
        /RCM call failed|RootChainManager contract failed to initialize/
      );
    });
  });

  // --- Tests for getLastCheckpointedL2Block ---
  describe('getLastCheckpointedL2Block', () => {
    beforeEach(async () => {
      // Successfully initialize service for these tests
      service = await PolygonRpcService.start(mockRuntime);
    });

    it('should return the last checkpointed L2 block number on success', async () => {
      const expectedBlock = 12345n;
      mockGetLastChildBlock.mockResolvedValueOnce(expectedBlock);
      const result = await service.getLastCheckpointedL2Block();
      expect(result).toBe(expectedBlock);
      // Verify that the mockGetLastChildBlock (method on CheckpointManager instance) was called
      expect(mockGetLastChildBlock).toHaveBeenCalled();
    });

    it('should throw an error if CheckpointManager.getLastChildBlock fails', async () => {
      mockGetLastChildBlock.mockRejectedValueOnce(new Error('Eth call error'));
      await expect(service.getLastCheckpointedL2Block()).rejects.toThrow(
        'Failed to fetch last checkpointed L2 block: Eth call error'
      );
    });

    it('should throw if service is not properly initialized (e.g. no start call)', async () => {
      const uninitializedService = new PolygonRpcService(mockRuntime); // No PolygonRpcService.start()
      await expect(uninitializedService.getLastCheckpointedL2Block()).rejects.toThrow(
        'CheckpointManager L1 contract is not initialized.'
      );
    });
  });

  // --- Tests for isL2BlockCheckpointed ---
  describe('isL2BlockCheckpointed', () => {
    beforeEach(async () => {
      // Successfully initialize service for these tests
      service = await PolygonRpcService.start(mockRuntime);
    });

    it('should return true if L2 block is less than last checkpointed block', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      expect(await service.isL2BlockCheckpointed(900n)).toBe(true);
      expect(mockGetLastChildBlock).toHaveBeenCalled();
    });

    it('should return true if L2 block is equal to last checkpointed block', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      expect(await service.isL2BlockCheckpointed(1000n)).toBe(true);
    });

    it('should return false if L2 block is greater than last checkpointed block', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      expect(await service.isL2BlockCheckpointed(1100n)).toBe(false);
    });

    it('should handle number input for l2BlockNumber', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      expect(await service.isL2BlockCheckpointed(900)).toBe(true);
    });

    it('should throw an error if getLastCheckpointedL2Block (internally) fails', async () => {
      mockGetLastChildBlock.mockRejectedValueOnce(new Error('Internal eth call error'));
      await expect(service.isL2BlockCheckpointed(100n)).rejects.toThrow(
        'Failed to determine checkpoint status for L2 block 100: Failed to fetch last checkpointed L2 block: Internal eth call error'
      );
    });

    it('should throw if service is not properly initialized (e.g. no start call)', async () => {
      const uninitializedService = new PolygonRpcService(mockRuntime); // No PolygonRpcService.start()
      await expect(uninitializedService.isL2BlockCheckpointed(100n)).rejects.toThrow(
        'CheckpointManager L1 contract is not initialized.'
      );
    });
  });
});
