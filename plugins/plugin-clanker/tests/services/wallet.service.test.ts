import { describe, it, expect, beforeEach } from 'bun:test';
import { WalletService } from '../../src/services/wallet.service';
import { ClankerError, ErrorCode } from '../../src/utils/errors';
import { parseUnits } from 'ethers';

// Mock runtime
const mockRuntime = {
  getSetting: (key: string) => {
    if (key === 'clanker') {
      return {
        BASE_RPC_URL: 'https://mainnet.base.org',
        WALLET_PRIVATE_KEY: '0x' + '0'.repeat(64),
        DEFAULT_SLIPPAGE: 0.05,
        MAX_GAS_PRICE: '100000000000',
        RETRY_ATTEMPTS: 3,
        NETWORK: 'base',
      };
    }
    return null;
  },
};

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(() => {
    service = new WalletService(mockRuntime as any);
  });

  describe('initialize', () => {
    it('should throw error without private key', async () => {
      const badRuntime = {
        getSetting: () => ({
          BASE_RPC_URL: 'https://mainnet.base.org',
          // Missing WALLET_PRIVATE_KEY
        }),
      };
      const badService = new WalletService(badRuntime as any);
      await expect(badService.initialize(badRuntime as any)).rejects.toThrow();
    });

    it('should throw error without config', async () => {
      const badRuntime = {
        getSetting: () => null,
      };
      const badService = new WalletService(badRuntime as any);
      await expect(badService.initialize(badRuntime as any)).rejects.toThrow(ClankerError);
    });
  });

  describe('getAddress', () => {
    it('should throw error when not initialized', async () => {
      await expect(service.getAddress()).rejects.toThrow(ClankerError);
    });
  });

  describe('signTransaction', () => {
    it('should throw error when not initialized', async () => {
      const tx = {
        to: '0x' + '1'.repeat(40),
        value: parseUnits('1', 18),
      };
      await expect(service.signTransaction(tx)).rejects.toThrow(ClankerError);
    });
  });

  describe('getBalance', () => {
    it('should throw error when not initialized', async () => {
      await expect(service.getBalance()).rejects.toThrow(ClankerError);
    });
  });

  describe('getTransactionMonitor', () => {
    it('should return transaction monitor instance', () => {
      const monitor = service.getTransactionMonitor();
      expect(monitor).toBeDefined();
      expect(monitor.addTransaction).toBeDefined();
      expect(monitor.updateTransaction).toBeDefined();
    });
  });
});
