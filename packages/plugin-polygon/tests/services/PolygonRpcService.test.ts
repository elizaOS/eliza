import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PolygonRpcService,
  ValidatorStatus,
  type ValidatorInfo,
  type DelegatorInfo,
} from '../../src/services/PolygonRpcService';
import { ethers } from 'ethers';
import { 
  mockRuntime,
  mockValidatorShareContract,
  mockStakeManagerContractEthers
} from '../../vitest.setup';

// Define a test-specific error type
interface TestError extends Error {
  code?: string;
}

// Important contract addresses
const STAKE_MANAGER_ADDRESS_L1 = '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908';
const ROOT_CHAIN_MANAGER_ADDRESS_L1 = '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77';
const VALIDATOR_SHARE_ADDRESS_MOCK = '0xValidatorShareContractAddress';

// Mock ethers which is used by the service
vi.mock('ethers');

describe('PolygonRpcService', () => {
  let service: PolygonRpcService;

  beforeEach(async () => {
    // Reset all method mocks on the contract instances
    for (const mockFn of Object.values(mockStakeManagerContractEthers)) {
      if (typeof mockFn === 'function' && mockFn.mockReset) {
        mockFn.mockReset();
      }
    }
    for (const mockFn of Object.values(mockValidatorShareContract)) {
      if (typeof mockFn === 'function' && mockFn.mockReset) {
        mockFn.mockReset();
      }
    }

    // Set up defaults for tests
    mockStakeManagerContractEthers.validatorThreshold.mockResolvedValue(true);
    
    // Configure runtime for testing
    vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
      if (key === 'ETHEREUM_RPC_URL') return 'mock_l1_rpc_url';
      if (key === 'POLYGON_RPC_URL') return 'mock_l2_rpc_url';
      if (key === 'PRIVATE_KEY') return '0x1234567890123456789012345678901234567890123456789012345678901234';
      return null;
    });
    
    service = await PolygonRpcService.start(mockRuntime);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Validator Operations', () => {
    describe('getValidatorInfo', () => {
      it('should return validator info for a valid ID', async () => {
        const validatorId = 5;
        const mockValidatorDataFromContract = {
          status: ValidatorStatus.Active, // Numeric status
          amount: ethers.parseUnits('1000', 18), // Total stake
          // commissionRate is not in ABI's validators struct
          signer: '0xSignerAddress',
          activationEpoch: 100n,
          deactivationEpoch: 0n,
          jailTime: 0n,
          contractAddress: '0xValidatorShareRealAddress',
          // lastRewardUpdateEpoch is not in ABI's validators struct
        };
        mockStakeManagerContractEthers.validators.mockResolvedValue(mockValidatorDataFromContract);

        const result: ValidatorInfo | null = await service.getValidatorInfo(validatorId);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(ValidatorStatus.Active);
        expect(result?.totalStake).toEqual(ethers.parseUnits('1000', 18));
        expect(result?.commissionRate).toBe(0); // Defaulted as not in ABI
        expect(result?.signerAddress).toBe('0xSignerAddress');
        expect(result?.activationEpoch).toBe(100n);
        expect(result?.contractAddress).toBe('0xValidatorShareRealAddress');
        expect(result?.lastRewardUpdateEpoch).toBe(0n); // Defaulted
        expect(mockStakeManagerContractEthers.validators).toHaveBeenCalledWith(validatorId);
      });

      it('should return null if validator not found (signer is ZeroAddress)', async () => {
        const validatorId = 999;
        const mockValidatorDataFromContract = {
          signer: ethers.ZeroAddress, // Indicates validator not found or inactive
          // Other fields might be zeroed out or default
          status: ValidatorStatus.Inactive,
          amount: 0n,
          activationEpoch: 0n,
          deactivationEpoch: 0n,
          jailTime: 0n,
          contractAddress: ethers.ZeroAddress,
        };
        mockStakeManagerContractEthers.validators.mockResolvedValue(mockValidatorDataFromContract);

        const result = await service.getValidatorInfo(validatorId);
        expect(result).toBeNull();
      });

      it('should return null if validator data is null/undefined from contract', async () => {
        const validatorId = 777;
        mockStakeManagerContractEthers.validators.mockResolvedValue(null);
        const result = await service.getValidatorInfo(validatorId);
        expect(result).toBeNull();
      });

      it('should throw an error if the contract call fails', async () => {
        const validatorId = 13;
        const contractError = new Error('Network error');
        mockStakeManagerContractEthers.validators.mockRejectedValue(contractError);

        await expect(service.getValidatorInfo(validatorId)).rejects.toThrow(contractError);
      });
    });

    describe('getDelegatorInfo', () => {
      const validatorId = 10;
      const delegatorAddress = '0xDelegatorAddress';

      beforeEach(() => {
        // Default successful mock for getValidatorContract for these tests
        mockStakeManagerContractEthers.getValidatorContract.mockResolvedValue(
          VALIDATOR_SHARE_ADDRESS_MOCK
        );
      });

      it('should return delegator info for valid validator and delegator', async () => {
        const mockDelegatedAmount = ethers.parseUnits('500', 18);
        const mockPendingRewards = ethers.parseUnits('50', 18);

        mockValidatorShareContract.getTotalStake.mockResolvedValue(mockDelegatedAmount);
        mockValidatorShareContract.getLiquidRewards.mockResolvedValue(mockPendingRewards);

        const result: DelegatorInfo | null = await service.getDelegatorInfo(
          validatorId,
          delegatorAddress
        );

        expect(result).not.toBeNull();
        expect(result?.delegatedAmount).toEqual(mockDelegatedAmount);
        expect(result?.pendingRewards).toEqual(mockPendingRewards);
        expect(mockStakeManagerContractEthers.getValidatorContract).toHaveBeenCalledWith(
          validatorId
        );
        expect(mockValidatorShareContract.getTotalStake).toHaveBeenCalledWith(
          delegatorAddress
        );
        expect(mockValidatorShareContract.getLiquidRewards).toHaveBeenCalledWith(
          delegatorAddress
        );
      });

      it('should return null if ValidatorShare contract address is ZeroAddress', async () => {
        mockStakeManagerContractEthers.getValidatorContract.mockResolvedValue(ethers.ZeroAddress);

        const result = await service.getDelegatorInfo(validatorId, delegatorAddress);
        expect(result).toBeNull();
      });

      it('should return null if ValidatorShare contract address is null', async () => {
        mockStakeManagerContractEthers.getValidatorContract.mockResolvedValue(null);
        const result = await service.getDelegatorInfo(validatorId, delegatorAddress);
        expect(result).toBeNull();
      });

      it('should throw an error if getValidatorContract fails', async () => {
        const contractError = new Error('Failed to get validator contract');
        mockStakeManagerContractEthers.getValidatorContract.mockRejectedValue(contractError);

        await expect(service.getDelegatorInfo(validatorId, delegatorAddress)).rejects.toThrow(
          contractError
        );
      });

      it('should throw an error if getTotalStake fails', async () => {
        const contractError = new Error('Failed to get total stake');
        mockValidatorShareContract.getTotalStake.mockRejectedValue(contractError);

        await expect(service.getDelegatorInfo(validatorId, delegatorAddress)).rejects.toThrow(
          contractError
        );
      });

      it('should throw an error if getLiquidRewards fails', async () => {
        const contractError = new Error('Failed to get liquid rewards');
        mockValidatorShareContract.getLiquidRewards.mockRejectedValue(contractError);

        await expect(service.getDelegatorInfo(validatorId, delegatorAddress)).rejects.toThrow(
          contractError
        );
      });

      it('should return null if contract call for rewards implies no stake (e.g. CALL_EXCEPTION)', async () => {
        // Simulate an error that the service method catches and interprets as "no stake"
        const callExceptionError: TestError = new Error('call revert exception');
        callExceptionError.code = 'CALL_EXCEPTION';
        mockValidatorShareContract.getLiquidRewards.mockRejectedValue(callExceptionError);
        // getTotalStake might still succeed or also throw. Let's assume it succeeds.
        mockValidatorShareContract.getTotalStake.mockResolvedValue(
          ethers.parseUnits('100', 18)
        );

        const result = await service.getDelegatorInfo(validatorId, delegatorAddress);
        // Based on the implementation: if (error.message.includes('delegator never staked') || error.code === 'CALL_EXCEPTION') return null;
        expect(result).toBeNull();
      });
    });
    
    describe('delegate', () => {
      it('should successfully delegate to a validator', async () => {
        const validatorId = 7;
        const amount = ethers.parseUnits('10', 18);
        const txHash = '0xDelegateTxHash';
        
        mockStakeManagerContractEthers.delegate.mockResolvedValue({ 
          hash: txHash, 
          wait: vi.fn().mockResolvedValue({ status: 1 })
        });
        
        const result = await service.delegate(validatorId, amount);
        
        expect(result).toBe(txHash);
        expect(mockStakeManagerContractEthers.delegate).toHaveBeenCalledWith(validatorId, amount);
      });
      
      it('should throw an error if delegation fails', async () => {
        const validatorId = 7;
        const amount = ethers.parseUnits('10', 18);
        const error = new Error('Delegation failed');
        
        mockStakeManagerContractEthers.delegate.mockRejectedValue(error);
        
        await expect(service.delegate(validatorId, amount)).rejects.toThrow(error);
      });
    });
  });
}); 