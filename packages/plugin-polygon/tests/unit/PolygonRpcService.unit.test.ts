import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import { 
  mockRuntime, 
  mockGetLastChildBlock,
  mockCheckpointManagerAddressFn,
  mockCurrentEpoch 
} from '../../vitest.setup';
import { resetCommonMocks } from '../test-helpers';

// Constants for the tests
const ROOT_CHAIN_MANAGER_ADDRESS_L1 = '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77';
const STAKE_MANAGER_ADDRESS_L1 = '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908';
const MOCK_CHECKPOINT_MANAGER_ADDR = '0xCheckpointManager123';

describe('PolygonRpcService Unit Tests', () => {
  let service: PolygonRpcService;

  beforeEach(async () => {
    resetCommonMocks();
    
    // Reset specific mock functions used in these tests
    mockGetLastChildBlock.mockReset().mockResolvedValue(1000n);
    mockCheckpointManagerAddressFn.mockReset().mockResolvedValue(MOCK_CHECKPOINT_MANAGER_ADDR);
    mockCurrentEpoch.mockReset().mockResolvedValue(1n);
    
    // Configure runtime for testing
    vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
      if (key === 'ETHEREUM_RPC_URL') return 'http://mock-l1-rpc.com';
      if (key === 'POLYGON_RPC_URL') return 'http://mock-l2-rpc.com';
      if (key === 'PRIVATE_KEY') return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      return null;
    });
    
    service = await PolygonRpcService.start(mockRuntime);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('PolygonRpcService.start (initialization)', () => {
    it('should initialize providers and contracts correctly', async () => {
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('ETHEREUM_RPC_URL');
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('POLYGON_RPC_URL');
      expect(mockRuntime.getSetting).toHaveBeenCalledWith('PRIVATE_KEY');
      
      // Verify that the appropriate contract method was called
      expect(mockCheckpointManagerAddressFn).toHaveBeenCalled();
      
      // Service should be properly instantiated
      expect(service).toBeInstanceOf(PolygonRpcService);
    });

    it('should throw if ETHEREUM_RPC_URL is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return 'http://mock-l2-rpc.com';
        if (key === 'PRIVATE_KEY') return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        return null;
      });
      
      await expect(PolygonRpcService.start(mockRuntime)).rejects.toThrow('Missing L1/L2 RPC URLs');
    });

    it('should throw if PRIVATE_KEY is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'ETHEREUM_RPC_URL') return 'http://mock-l1-rpc.com';
        if (key === 'POLYGON_RPC_URL') return 'http://mock-l2-rpc.com';
        return null;
      });
      
      await expect(PolygonRpcService.start(mockRuntime)).rejects.toThrow(
        'Missing PRIVATE_KEY for signer initialization'
      );
    });

    it('should throw if RootChainManager.checkpointManagerAddress fails', async () => {
      mockCheckpointManagerAddressFn.mockRejectedValueOnce(new Error('RCM call failed'));
      
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'ETHEREUM_RPC_URL') return 'http://mock-l1-rpc.com';
        if (key === 'POLYGON_RPC_URL') return 'http://mock-l2-rpc.com';
        if (key === 'PRIVATE_KEY') return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        return null;
      });
      
      await expect(PolygonRpcService.start(mockRuntime)).rejects.toThrow('RCM call failed');
    });
  });

  describe('getLastCheckpointedL2Block', () => {
    it('should return the last checkpointed L2 block number on success', async () => {
      const expectedBlock = 12345n;
      mockGetLastChildBlock.mockResolvedValueOnce(expectedBlock);
      
      const result = await service.getLastCheckpointedL2Block();
      
      expect(result).toBe(expectedBlock);
      expect(mockGetLastChildBlock).toHaveBeenCalled();
    });

    it('should throw an error if CheckpointManager.getLastChildBlock fails', async () => {
      mockGetLastChildBlock.mockRejectedValueOnce(new Error('Eth call error'));
      
      await expect(service.getLastCheckpointedL2Block()).rejects.toThrow(
        'Failed to fetch last checkpointed L2 block: Eth call error'
      );
    });
  });

  describe('isL2BlockCheckpointed', () => {
    it('should return true if L2 block is less than last checkpointed block', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      
      const result = await service.isL2BlockCheckpointed(500n);
      
      expect(result).toBe(true);
      expect(mockGetLastChildBlock).toHaveBeenCalled();
    });

    it('should return true if L2 block is equal to last checkpointed block', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      
      const result = await service.isL2BlockCheckpointed(1000n);
      
      expect(result).toBe(true);
    });

    it('should return false if L2 block is greater than last checkpointed block', async () => {
      mockGetLastChildBlock.mockResolvedValueOnce(1000n);
      
      const result = await service.isL2BlockCheckpointed(1500n);
      
      expect(result).toBe(false);
    });

    it('should throw an error if getLastCheckpointedL2Block fails', async () => {
      mockGetLastChildBlock.mockRejectedValueOnce(new Error('RPC down'));
      
      await expect(service.isL2BlockCheckpointed(500n)).rejects.toThrow(
        'Failed to fetch last checkpointed L2 block: RPC down'
      );
    });
  });

  describe('getL2Provider', () => {
    it('should return the L2 provider if initialized', async () => {
      const provider = service.getL2Provider();
      
      expect(provider).toBeDefined();
      expect(provider).toHaveProperty('getNetwork');
    });
  });
}); 