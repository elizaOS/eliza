/// <reference types="vitest/globals" />
import { describe, expect, it, beforeEach } from 'vitest';
import { DummySwapService } from '../service';
import { type IAgentRuntime } from '@elizaos/core';

describe('DummySwapService', () => {
  let service: DummySwapService;
  const mockRuntime = {} as IAgentRuntime;

  beforeEach(async () => {
    service = new DummySwapService(mockRuntime);
    await service.start();
  });

  it('should get a swap quote', async () => {
    const quoteParams = {
      inputMint: 'SOL',
      outputMint: 'USDC',
      amount: 1_000_000_000, // 1 SOL
    };
    const quote = await service.getQuote(quoteParams);

    expect(quote).toBeDefined();
    expect(quote.inAmount).toBe(String(quoteParams.amount));
    expect(Number(quote.outAmount)).toBeCloseTo(quoteParams.amount * 0.99);
    expect(quote.priceImpact).toBe(0.001);
    expect(quote.route).toHaveLength(1);
    expect(quote.route[0].dex).toBe('dummy-dex');
  });

  it('should execute a swap', async () => {
    const swapParams = {
      user: 'test-user',
      inputMint: 'SOL',
      outputMint: 'USDC',
      amount: 1_000_000_000,
    };
    const result = await service.swap(swapParams);

    expect(result.success).toBe(true);
    expect(result.transactionId).toMatch(/^dummy-swap-tx-/);
  });

  it('should get a list of supported tokens', async () => {
    const tokens = await service.getSupportedTokens();
    expect(tokens).toBeDefined();
    expect(tokens).toHaveLength(2);
    expect(tokens?.map((t) => t.symbol)).toContain('SOL');
    expect(tokens?.map((t) => t.symbol)).toContain('USDC');
  });
});
