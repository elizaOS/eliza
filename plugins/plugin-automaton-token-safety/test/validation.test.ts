import { describe, it, expect } from 'vitest';
import { inputSchemas } from '../src/schemas.js';

describe('Plugin Automaton Token Safety - Input Schema Validation', () => {
  const VALID_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const INVALID_ADDR = '0x1234';

  describe('AUTOMATON_SCAN schema', () => {
    it('accepts valid 40-hex 0x-prefixed address', () => {
      const res = inputSchemas.scan.safeParse({ address: VALID_ADDR });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.address).toBe(VALID_ADDR);
      }
    });

    it('rejects invalid address format', () => {
      const res = inputSchemas.scan.safeParse({ address: INVALID_ADDR });
      expect(res.success).toBe(false);
    });

    it('rejects unknown extra properties (strict)', () => {
      const res = inputSchemas.scan.safeParse({ address: VALID_ADDR, unexpected: 'injected' });
      expect(res.success).toBe(false);
    });
  });

  describe('AUTOMATON_SIMULATE schema', () => {
    it('accepts positive decimal string amounts', () => {
      const res1 = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'buy',
        amount: '0.001',
        wallet: VALID_ADDR
      });
      expect(res1.success).toBe(true);

      const res2 = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'sell',
        amount: '100.5',
        wallet: VALID_ADDR
      });
      expect(res2.success).toBe(true);
    });

    it('strictly rejects zero amounts (0, 0.0, 0.000)', () => {
      const res0 = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'buy',
        amount: '0',
        wallet: VALID_ADDR
      });
      expect(res0.success).toBe(false);

      const res0dot0 = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'buy',
        amount: '0.0',
        wallet: VALID_ADDR
      });
      expect(res0dot0.success).toBe(false);

      const res0dot000 = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'buy',
        amount: '0.000',
        wallet: VALID_ADDR
      });
      expect(res0dot000.success).toBe(false);
    });

    it('rejects negative or invalid non-numeric amounts', () => {
      const resNeg = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'buy',
        amount: '-1.5',
        wallet: VALID_ADDR
      });
      expect(resNeg.success).toBe(false);

      const resAlpha = inputSchemas.simulate.safeParse({
        token: VALID_ADDR,
        side: 'buy',
        amount: 'abc',
        wallet: VALID_ADDR
      });
      expect(resAlpha.success).toBe(false);
    });
  });

  describe('AUTOMATON_APPROVAL_RISK schema', () => {
    it('accepts valid token and owner with optional spenders', () => {
      const res = inputSchemas['approval-risk'].safeParse({
        token: VALID_ADDR,
        owner: VALID_ADDR,
        spenders: [VALID_ADDR]
      });
      expect(res.success).toBe(true);
    });

    it('rejects invalid spender address', () => {
      const res = inputSchemas['approval-risk'].safeParse({
        token: VALID_ADDR,
        owner: VALID_ADDR,
        spenders: [INVALID_ADDR]
      });
      expect(res.success).toBe(false);
    });
  });

  describe('AUTOMATON_SENTINEL_LATEST schema', () => {
    it('accepts valid parameters and valid DEX enum', () => {
      const res = inputSchemas['sentinel-latest'].safeParse({
        limit: 50,
        maxRisk: 20,
        dex: 'uniswap-v4'
      });
      expect(res.success).toBe(true);
    });

    it('rejects invalid DEX names', () => {
      const res = inputSchemas['sentinel-latest'].safeParse({
        dex: 'pancakeswap' as any
      });
      expect(res.success).toBe(false);
    });
  });

  describe('AUTOMATON_LIQUIDITY_RISK schema', () => {
    it('accepts valid token address', () => {
      const res = inputSchemas['liquidity-risk'].safeParse({
        token: VALID_ADDR
      });
      expect(res.success).toBe(true);
    });
  });
});
