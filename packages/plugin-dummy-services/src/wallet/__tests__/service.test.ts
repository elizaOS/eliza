import { describe, expect, it, beforeEach } from 'bun:test';
import { DummyWalletService } from '../service';
import { type AgentRuntime } from '@elizaos/core';

describe('DummyWalletService', () => {
  let service: DummyWalletService;
  const mockRuntime = {} as AgentRuntime;

  beforeEach(async () => {
    service = new DummyWalletService(mockRuntime);
    await service.start();
  });

  describe('initialization', () => {
    it('should initialize with default USDC balance', async () => {
      const balance = await service.getBalance('USDC');
      expect(balance).toBe(10000);
    });

    it('should have empty balances for other assets', async () => {
      const solBalance = await service.getBalance('SOL');
      expect(solBalance).toBe(0);
    });
  });

  describe('addFunds', () => {
    it('should add funds to an existing balance', async () => {
      await service.addFunds('USDC', 500);
      const balance = await service.getBalance('USDC');
      expect(balance).toBe(10500);
    });

    it('should create a new balance for a new asset', async () => {
      await service.addFunds('SOL', 10);
      const balance = await service.getBalance('SOL');
      expect(balance).toBe(10);
    });

    it('should handle multiple additions', async () => {
      await service.addFunds('SOL', 5);
      await service.addFunds('SOL', 3);
      const balance = await service.getBalance('SOL');
      expect(balance).toBe(8);
    });
  });

  describe('setPortfolioHolding', () => {
    it('should set portfolio holding for non-quote asset', async () => {
      await service.setPortfolioHolding('SOL', 5, 100);
      const balance = await service.getBalance('SOL');
      expect(balance).toBe(5);
    });

    it('should convert to addFunds for quote asset', async () => {
      // Setting portfolio holding for USDC should add the value
      await service.setPortfolioHolding('USDC', 100, 1);
      const balance = await service.getBalance('USDC');
      expect(balance).toBe(10100); // 10000 initial + 100
    });
  });

  describe('resetWallet', () => {
    it('should reset wallet with new initial cash', async () => {
      await service.addFunds('SOL', 10);
      await service.resetWallet(5000);

      const usdcBalance = await service.getBalance('USDC');
      const solBalance = await service.getBalance('SOL');

      expect(usdcBalance).toBe(5000);
      expect(solBalance).toBe(0);
    });

    it('should support different quote assets', async () => {
      await service.resetWallet(2000, 'USDT');

      const usdtBalance = await service.getBalance('USDT');
      const usdcBalance = await service.getBalance('USDC');

      expect(usdtBalance).toBe(2000);
      expect(usdcBalance).toBe(0);
    });
  });

  describe('getPortfolio', () => {
    it('should return correct portfolio structure', async () => {
      const portfolio = await service.getPortfolio();

      expect(portfolio).toHaveProperty('totalValueUsd');
      expect(portfolio).toHaveProperty('assets');
      expect(Array.isArray(portfolio.assets)).toBe(true);
      expect(portfolio.totalValueUsd).toBe(10000); // Initial USDC balance
    });

    it('should calculate correct total value with multiple assets', async () => {
      await service.setPortfolioHolding('SOL', 2, 100); // 2 SOL @ $100 = $200
      await service.setPortfolioHolding('ETH', 1, 2000); // 1 ETH @ $2000 = $2000

      const portfolio = await service.getPortfolio();

      expect(portfolio.totalValueUsd).toBe(12200); // 10000 USDC + 200 SOL + 2000 ETH
      expect(portfolio.assets.length).toBe(3);
    });

    it('should include all required fields in assets', async () => {
      await service.addFunds('SOL', 5);
      const portfolio = await service.getPortfolio();

      const solAsset = portfolio.assets.find((a) => a.symbol === 'SOL');
      expect(solAsset).toBeDefined();
      expect(solAsset).toHaveProperty('address');
      expect(solAsset).toHaveProperty('symbol');
      expect(solAsset).toHaveProperty('balance');
      expect(solAsset).toHaveProperty('decimals');
      expect(solAsset).toHaveProperty('quantity');
      expect(solAsset).toHaveProperty('averagePrice');
      expect(solAsset).toHaveProperty('value');
    });
  });

  describe('transferSol', () => {
    it('should transfer SOL when sufficient balance exists', async () => {
      await service.addFunds('SOL', 5);

      const txHash = await service.transferSol('from-address', 'to-address', 2e9); // 2 SOL in lamports

      expect(txHash).toMatch(/^dummy-tx-/);
      const balance = await service.getBalance('SOL');
      expect(balance).toBe(3); // 5 - 2 = 3
    });

    it('should throw error when insufficient balance', async () => {
      await service.addFunds('SOL', 1);

      await expect(service.transferSol('from-address', 'to-address', 2e9)).rejects.toThrow(
        'Insufficient SOL balance'
      );
    });

    it('should handle transfer when no SOL balance exists', async () => {
      await expect(service.transferSol('from-address', 'to-address', 1e9)).rejects.toThrow(
        'Insufficient SOL balance'
      );
    });
  });

  describe('static methods', () => {
    it('should create instance through static start method', async () => {
      const instance = await DummyWalletService.start(mockRuntime);
      expect(instance).toBeInstanceOf(DummyWalletService);

      const balance = await instance.getBalance('USDC');
      expect(balance).toBe(10000);
    });
  });

  describe('stop', () => {
    it('should clear all balances when stopped', async () => {
      await service.addFunds('SOL', 10);
      await service.stop();

      // After stop, balances should be cleared
      const portfolio = await service.getPortfolio();
      expect(portfolio.assets.length).toBe(0);
      expect(portfolio.totalValueUsd).toBe(0);
    });
  });
});
