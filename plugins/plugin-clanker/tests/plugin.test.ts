import { describe, it, expect, beforeEach } from 'bun:test';
import { clankerPlugin } from '../src/plugin';
import { z } from 'zod';

describe('clankerPlugin', () => {
  beforeEach(() => {
    // Clear global config before each test
    (global as any).__clankerConfig = undefined;
  });

  describe('plugin structure', () => {
    it('should have required properties', () => {
      expect(clankerPlugin.name).toBe('plugin-clanker');
      expect(clankerPlugin.description).toBeDefined();
      expect(clankerPlugin.services).toBeDefined();
      expect(clankerPlugin.actions).toBeDefined();
      expect(clankerPlugin.providers).toBeDefined();
      expect(clankerPlugin.evaluators).toBeDefined();
      expect(clankerPlugin.init).toBeDefined();
    });

    it('should have correct number of services', () => {
      expect(clankerPlugin.services).toHaveLength(2);
    });

    it('should have correct number of actions', () => {
      expect(clankerPlugin.actions).toHaveLength(5);
    });

    it('should have correct number of providers', () => {
      expect(clankerPlugin.providers).toHaveLength(2);
    });

    it('should have correct number of evaluators', () => {
      expect(clankerPlugin.evaluators).toHaveLength(1);
    });
  });

  describe('init', () => {
    it('should initialize with valid config', async () => {
      const config = {
        BASE_RPC_URL: 'https://mainnet.base.org',
        WALLET_PRIVATE_KEY: '0x' + '0'.repeat(64),
      };

      await expect(clankerPlugin.init!(config)).resolves.not.toThrow();
      expect((global as any).__clankerConfig).toBeDefined();
      expect((global as any).__clankerConfig.BASE_RPC_URL).toBe(config.BASE_RPC_URL);
    });

    it('should throw error without required BASE_RPC_URL', async () => {
      const config = {
        WALLET_PRIVATE_KEY: '0x' + '0'.repeat(64),
      };

      await expect(clankerPlugin.init!(config)).rejects.toThrow('BASE_RPC_URL is required');
    });

    it('should throw error without required WALLET_PRIVATE_KEY', async () => {
      const config = {
        BASE_RPC_URL: 'https://mainnet.base.org',
      };

      await expect(clankerPlugin.init!(config)).rejects.toThrow('WALLET_PRIVATE_KEY is required');
    });

    it('should use default values', async () => {
      const config = {
        BASE_RPC_URL: 'https://mainnet.base.org',
        WALLET_PRIVATE_KEY: '0x' + '0'.repeat(64),
      };

      await clankerPlugin.init!(config);
      const storedConfig = (global as any).__clankerConfig;

      expect(storedConfig.DEFAULT_SLIPPAGE).toBe(0.05);
      expect(storedConfig.MAX_GAS_PRICE).toBe('100000000000');
      expect(storedConfig.RETRY_ATTEMPTS).toBe(3);
      expect(storedConfig.NETWORK).toBe('base');
    });

    it('should validate config with Zod schema', async () => {
      const config = {
        BASE_RPC_URL: '', // Invalid empty string
        WALLET_PRIVATE_KEY: '0x' + '0'.repeat(64),
      };

      await expect(clankerPlugin.init!(config)).rejects.toThrow(
        'Invalid Clanker plugin configuration'
      );
    });
  });

  describe('routes', () => {
    it('should have status route', () => {
      expect(clankerPlugin.routes).toBeDefined();
      expect(clankerPlugin.routes).toHaveLength(1);

      const statusRoute = clankerPlugin.routes![0];
      expect(statusRoute.name).toBe('clanker-status');
      expect(statusRoute.path).toBe('/api/clanker/status');
      expect(statusRoute.type).toBe('GET');
    });
  });

  describe('events', () => {
    it('should have transaction event handlers', () => {
      expect(clankerPlugin.events).toBeDefined();
      expect(clankerPlugin.events!.TRANSACTION_CONFIRMED).toBeDefined();
      expect(clankerPlugin.events!.TRANSACTION_FAILED).toBeDefined();
    });
  });
});
