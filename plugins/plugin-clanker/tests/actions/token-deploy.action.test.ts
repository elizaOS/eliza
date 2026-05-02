import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { tokenDeployAction } from '../../src/actions/token-deploy.action';
import { ClankerService } from '../../src/services/clanker.service';
import { WalletService } from '../../src/services/wallet.service';
import { parseUnits } from 'ethers';

// Mock services
const mockClankerService = {
  deployToken: mock(async (params) => ({
    contractAddress: '0x' + '1'.repeat(40),
    transactionHash: '0x' + '2'.repeat(64),
    deploymentCost: parseUnits('0.01', 18),
    tokenId: 'test_token_123',
  })),
};

const mockWalletService = {
  getBalance: mock(async () => parseUnits('1', 18)), // 1 ETH
  getAddress: mock(async () => '0x' + '3'.repeat(40)),
};

const mockRuntime = {
  getService: (serviceType: string) => {
    if (serviceType === ClankerService.serviceType) return mockClankerService;
    if (serviceType === WalletService.serviceType) return mockWalletService;
    return null;
  },
};

describe('tokenDeployAction', () => {
  beforeEach(() => {
    mockClankerService.deployToken.mockClear();
    mockWalletService.getBalance.mockClear();
  });

  describe('validate', () => {
    it('should return true for deployment intent', async () => {
      const message = {
        content: {
          text: 'Deploy a new token called MyToken',
        },
      };

      const result = await tokenDeployAction.validate(
        mockRuntime as any,
        message as any,
        undefined
      );

      expect(result).toBe(true);
    });

    it('should return false without deployment intent', async () => {
      const message = {
        content: {
          text: 'What is the weather today?',
        },
      };

      const result = await tokenDeployAction.validate(
        mockRuntime as any,
        message as any,
        undefined
      );

      expect(result).toBe(false);
    });

    it('should return false without services', async () => {
      const noServiceRuntime = {
        getService: () => null,
      };

      const message = {
        content: {
          text: 'Deploy a token',
        },
      };

      const result = await tokenDeployAction.validate(
        noServiceRuntime as any,
        message as any,
        undefined
      );

      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('should deploy token with parsed parameters', async () => {
      const message = {
        content: {
          text: 'Deploy a new token called "Based Token" with symbol BASE and 1 million supply',
          source: 'test',
        },
      };

      const result = await tokenDeployAction.handler(
        mockRuntime as any,
        message as any,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('contractAddress');
      expect(result.data).toHaveProperty('transactionHash');
      expect(mockClankerService.deployToken).toHaveBeenCalledTimes(1);

      const deployCall = mockClankerService.deployToken.mock.calls[0][0];
      expect(deployCall.name).toBe('Based Token');
      expect(deployCall.symbol).toBe('BASE');
      expect(deployCall.totalSupply).toBeDefined();
    });

    it('should handle insufficient balance', async () => {
      mockWalletService.getBalance.mockResolvedValueOnce(parseUnits('0.001', 18)); // Not enough

      const message = {
        content: {
          text: 'Create a token called TEST',
          source: 'test',
        },
      };

      const result = await tokenDeployAction.handler(
        mockRuntime as any,
        message as any,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockClankerService.deployToken).not.toHaveBeenCalled();
    });

    it('should use callback when provided', async () => {
      const mockCallback = mock();
      const message = {
        content: {
          text: 'Deploy PEPE token with 69 billion supply',
          source: 'test',
        },
      };

      await tokenDeployAction.handler(
        mockRuntime as any,
        message as any,
        undefined,
        {},
        mockCallback,
        undefined
      );

      expect(mockCallback).toHaveBeenCalledTimes(1);
      const callbackData = mockCallback.mock.calls[0][0];
      expect(callbackData.text).toContain('Token deployed successfully');
      expect(callbackData.actions).toContain('DEPLOY_TOKEN');
    });
  });
});
