/**
 * Unit Tests: Stripe Server Helpers
 *
 * Tests for Stripe server-side utility functions:
 * - calculatePointsFromUSD
 * - validatePurchaseAmount
 * - getBaseUrl
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

// Use cache-busting to avoid mocked versions from other test files.
const {
  calculatePointsFromUSD,
  getBaseUrl,
  POINTS_CONFIG,
  validatePurchaseAmount,
} = await import(
  `../../../../apps/web/src/lib/stripe/server?isolation=${Date.now()}`
);

describe('Stripe Server Helpers', () => {
  describe('POINTS_CONFIG', () => {
    it('should have correct configuration values', () => {
      expect(POINTS_CONFIG.POINTS_PER_DOLLAR).toBe(100);
      expect(POINTS_CONFIG.MIN_AMOUNT_USD).toBe(1);
      expect(POINTS_CONFIG.MAX_AMOUNT_USD).toBe(1000);
      expect(POINTS_CONFIG.CURRENCY).toBe('usd');
    });
  });

  describe('calculatePointsFromUSD', () => {
    it('should convert USD to points at 100 points per dollar', () => {
      expect(calculatePointsFromUSD(1)).toBe(100);
      expect(calculatePointsFromUSD(5)).toBe(500);
      expect(calculatePointsFromUSD(10)).toBe(1000);
      expect(calculatePointsFromUSD(100)).toBe(10000);
      expect(calculatePointsFromUSD(1000)).toBe(100000);
    });

    it('should floor decimal amounts', () => {
      expect(calculatePointsFromUSD(1.5)).toBe(150);
      expect(calculatePointsFromUSD(1.99)).toBe(199);
      expect(calculatePointsFromUSD(1.999)).toBe(199);
      expect(calculatePointsFromUSD(10.49)).toBe(1049);
    });

    it('should handle zero', () => {
      expect(calculatePointsFromUSD(0)).toBe(0);
    });

    it('should handle very small amounts', () => {
      expect(calculatePointsFromUSD(0.01)).toBe(1);
      expect(calculatePointsFromUSD(0.001)).toBe(0);
      expect(calculatePointsFromUSD(0.009)).toBe(0);
    });
  });

  describe('validatePurchaseAmount', () => {
    it('should accept valid amounts within range', () => {
      expect(validatePurchaseAmount(1)).toEqual({ valid: true });
      expect(validatePurchaseAmount(5)).toEqual({ valid: true });
      expect(validatePurchaseAmount(100)).toEqual({ valid: true });
      expect(validatePurchaseAmount(500)).toEqual({ valid: true });
      expect(validatePurchaseAmount(1000)).toEqual({ valid: true });
    });

    it('should accept decimal amounts within range', () => {
      expect(validatePurchaseAmount(1.5)).toEqual({ valid: true });
      expect(validatePurchaseAmount(99.99)).toEqual({ valid: true });
      expect(validatePurchaseAmount(999.99)).toEqual({ valid: true });
    });

    it('should reject amounts below minimum', () => {
      const result = validatePurchaseAmount(0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Minimum');
      expect(result.error).toContain('$1');
    });

    it('should reject zero amount', () => {
      const result = validatePurchaseAmount(0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Minimum');
    });

    it('should reject negative amounts', () => {
      const result = validatePurchaseAmount(-10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Minimum');
    });

    it('should reject amounts above maximum', () => {
      const result = validatePurchaseAmount(1001);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Maximum');
      expect(result.error).toContain('$1000');
    });

    it('should reject very large amounts', () => {
      const result = validatePurchaseAmount(100000);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Maximum');
    });

    it('should reject NaN', () => {
      const result = validatePurchaseAmount(NaN);
      expect(result.valid).toBe(false);
    });

    it('should reject Infinity', () => {
      const result = validatePurchaseAmount(Infinity);
      expect(result.valid).toBe(false);
      // Infinity fails isFinite check, which triggers "Minimum" error message
      expect(result.error).toBeDefined();
    });

    it('should reject negative Infinity', () => {
      const result = validatePurchaseAmount(-Infinity);
      expect(result.valid).toBe(false);
    });

    it('should handle boundary cases precisely', () => {
      // Exactly at min
      expect(validatePurchaseAmount(1)).toEqual({ valid: true });
      // Just below min
      expect(validatePurchaseAmount(0.99).valid).toBe(false);
      // Exactly at max
      expect(validatePurchaseAmount(1000)).toEqual({ valid: true });
      // Just above max
      expect(validatePurchaseAmount(1000.01).valid).toBe(false);
    });
  });

  describe('getBaseUrl', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // Clear relevant env vars before each test
      delete process.env.STRIPE_REDIRECT_BASE_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.VERCEL_URL;
    });

    afterEach(() => {
      // Restore original env
      process.env.STRIPE_REDIRECT_BASE_URL =
        originalEnv.STRIPE_REDIRECT_BASE_URL;
      process.env.NEXT_PUBLIC_APP_URL = originalEnv.NEXT_PUBLIC_APP_URL;
      process.env.VERCEL_URL = originalEnv.VERCEL_URL;
    });

    it('should prioritize STRIPE_REDIRECT_BASE_URL if set', () => {
      process.env.STRIPE_REDIRECT_BASE_URL = 'http://localhost:3001';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
      process.env.VERCEL_URL = 'my-app.vercel.app';

      const result = getBaseUrl('https://request-origin.com');
      expect(result).toBe('http://localhost:3001');
    });

    it('should use requestOrigin if in allowlist and STRIPE_REDIRECT_BASE_URL not set', () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

      // Use an origin from the allowlist (localhost:3000)
      const result = getBaseUrl('http://localhost:3000');
      expect(result).toBe('http://localhost:3000');
    });

    it('should reject untrusted origins and fall back to NEXT_PUBLIC_APP_URL', () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

      // Untrusted origin should be rejected for security
      const result = getBaseUrl('https://malicious-site.com');
      expect(result).toBe('https://app.example.com');
    });

    it('should fall back to NEXT_PUBLIC_APP_URL if no requestOrigin', () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

      const result = getBaseUrl();
      expect(result).toBe('https://app.example.com');
    });

    it('should fall back to VERCEL_URL if no NEXT_PUBLIC_APP_URL', () => {
      process.env.VERCEL_URL = 'my-app.vercel.app';

      const result = getBaseUrl();
      expect(result).toBe('https://my-app.vercel.app');
    });

    it('should fall back to localhost if no env vars set', () => {
      const result = getBaseUrl();
      expect(result).toBe('http://localhost:3000');
    });

    it('should handle empty requestOrigin', () => {
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

      const result = getBaseUrl('');
      expect(result).toBe('https://app.example.com');
    });
  });
});

describe('Points Pricing Calculations', () => {
  it('should be consistent: $1 = 100 points', () => {
    const amountUSD = 1;
    const points = calculatePointsFromUSD(amountUSD);
    expect(points).toBe(100);
  });

  it('should be consistent: $10 = 1000 points', () => {
    const amountUSD = 10;
    const points = calculatePointsFromUSD(amountUSD);
    expect(points).toBe(1000);
  });

  it('should be consistent: $1000 = 100000 points (max purchase)', () => {
    const amountUSD = 1000;
    const validation = validatePurchaseAmount(amountUSD);
    const points = calculatePointsFromUSD(amountUSD);

    expect(validation.valid).toBe(true);
    expect(points).toBe(100000);
  });

  it('validation and calculation should work together for common amounts', () => {
    const commonAmounts = [1, 5, 10, 20, 50, 100, 500, 1000];

    for (const amount of commonAmounts) {
      const validation = validatePurchaseAmount(amount);
      const points = calculatePointsFromUSD(amount);

      expect(validation.valid).toBe(true);
      expect(points).toBe(amount * 100);
    }
  });
});
