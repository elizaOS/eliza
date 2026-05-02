import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { ClankerService } from '../../src/services/clanker.service';
import { ClankerError } from '../../src/utils/errors';

const originalEnv = { ...process.env };

beforeAll(() => {
  process.env.BASE_RPC_URL = 'https://mainnet.base.org';
  process.env.WALLET_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.DEFAULT_SLIPPAGE = '0.05';
  process.env.MAX_GAS_PRICE = '100000000000';
  process.env.RETRY_ATTEMPTS = '3';
  process.env.CLANKER_NETWORK = 'base';
});

afterAll(() => {
  process.env = originalEnv;
});

const mockRuntime = {
  getSetting: () => null,
};

describe('ClankerService', () => {
  describe('construction', () => {
    it('should construct service successfully', () => {
      const service = new ClankerService(mockRuntime as any);
      expect(service).toBeDefined();
      expect(service.deployToken).toBeDefined();
      expect(service.getTokenInfo).toBeDefined();
    });

    it('should expose ClankerError class', () => {
      expect(ClankerError).toBeDefined();
    });
  });

  describe('initialize', () => {
    it.skip('should initialize successfully with valid config (requires real RPC)', async () => {
      const service = new ClankerService(mockRuntime as any);
      await expect(service.initialize(mockRuntime as any)).resolves.not.toThrow();
    });

    it('should throw error when WALLET_PRIVATE_KEY is missing', async () => {
      const previous = process.env.WALLET_PRIVATE_KEY;
      process.env.WALLET_PRIVATE_KEY = '';
      const service = new ClankerService(mockRuntime as any);
      await expect(service.initialize(mockRuntime as any)).rejects.toThrow(ClankerError);
      process.env.WALLET_PRIVATE_KEY = previous;
    });
  });

  describe('deployToken validation', () => {
    let service: ClankerService;

    beforeEach(() => {
      service = new ClankerService(mockRuntime as any);
    });

    it('should reject empty name', async () => {
      await expect(
        service.deployToken({
          name: '',
          symbol: 'TEST',
        })
      ).rejects.toThrow();
    });

    it('should reject overly long symbol', async () => {
      await expect(
        service.deployToken({
          name: 'Test Token',
          symbol: 'VERYLONGSYMBOL',
        })
      ).rejects.toThrow();
    });

    it('should reject overly long name', async () => {
      await expect(
        service.deployToken({
          name: 'A'.repeat(51),
          symbol: 'TEST',
        })
      ).rejects.toThrow();
    });
  });

  describe('getTokenInfo validation', () => {
    it('should reject invalid token address', async () => {
      const service = new ClankerService(mockRuntime as any);
      await expect(service.getTokenInfo('invalid-address')).rejects.toThrow();
    });
  });
});
