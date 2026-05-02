import { describe, it, expect } from 'bun:test';
import {
  formatTokenAmount,
  parseTokenAmount,
  formatUsd,
  formatPercentage,
  shortenAddress,
  formatTransactionHash,
  calculatePriceImpact,
  formatBalance,
  formatGasPrice,
} from '../../src/utils/format';
import { parseUnits } from 'ethers';

describe('formatTokenAmount', () => {
  it('should format token amounts correctly', () => {
    expect(formatTokenAmount(parseUnits('1', 18), 18)).toBe('1.0');
    expect(formatTokenAmount(parseUnits('1.5', 18), 18)).toBe('1.5');
    expect(formatTokenAmount(parseUnits('1000', 6), 6)).toBe('1000.0');
    expect(formatTokenAmount(0n, 18)).toBe('0.0');
  });
});

describe('parseTokenAmount', () => {
  it('should parse token amounts correctly', () => {
    expect(parseTokenAmount('1', 18)).toBe(parseUnits('1', 18));
    expect(parseTokenAmount('1.5', 18)).toBe(parseUnits('1.5', 18));
    expect(parseTokenAmount('1000', 6)).toBe(parseUnits('1000', 6));
    expect(parseTokenAmount('0', 18)).toBe(0n);
  });
});

describe('formatUsd', () => {
  it('should format USD amounts correctly', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(1000)).toBe('$1,000.00');
    expect(formatUsd(0.123456)).toBe('$0.123456');
    expect(formatUsd(0.1234567)).toBe('$0.123457');
  });
});

describe('formatPercentage', () => {
  it('should format percentages correctly', () => {
    expect(formatPercentage(0)).toBe('0.00%');
    expect(formatPercentage(0.01)).toBe('1.00%');
    expect(formatPercentage(0.055)).toBe('5.50%');
    expect(formatPercentage(1)).toBe('100.00%');
    expect(formatPercentage(-0.05)).toBe('-5.00%');
  });
});

describe('shortenAddress', () => {
  it('should shorten addresses correctly', () => {
    expect(shortenAddress('0x' + '1'.repeat(40))).toBe('0x1111...1111');
    expect(shortenAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe('0xEeee...EEeE');
    expect(shortenAddress('0x1234567890abcdef')).toBe('0x1234...cdef');
  });

  it('should handle short strings', () => {
    expect(shortenAddress('')).toBe('');
    expect(shortenAddress('0x')).toBe('0x');
    expect(shortenAddress('0x123')).toBe('0x123');
  });
});

describe('formatTransactionHash', () => {
  it('should format transaction hashes', () => {
    expect(formatTransactionHash('0x' + '1'.repeat(64))).toBe('0x1111...1111');
    expect(formatTransactionHash('0xabcdef1234567890')).toBe('0xabcd...7890');
  });
});

describe('calculatePriceImpact', () => {
  it('should calculate price impact correctly', () => {
    expect(calculatePriceImpact(100n, 98n, 1, 1)).toBe(0.02);
    expect(calculatePriceImpact(100n, 95n, 1, 1)).toBe(0.05);
    expect(calculatePriceImpact(100n, 100n, 1, 1)).toBe(0);
  });

  it('should handle different prices', () => {
    expect(calculatePriceImpact(100n, 200n, 1, 0.5)).toBe(0);
    expect(calculatePriceImpact(100n, 90n, 1, 1.1)).toBeCloseTo(0.01, 5);
  });

  it('should handle zero input value', () => {
    expect(calculatePriceImpact(0n, 100n, 1, 1)).toBe(0);
  });
});

describe('formatBalance', () => {
  it('should format balance with symbol', () => {
    expect(formatBalance(parseUnits('1', 18), 18, 'ETH')).toBe('1.0 ETH');
    expect(formatBalance(parseUnits('1000', 6), 6, 'USDC')).toBe('1000.0 USDC');
    expect(formatBalance(0n, 18, 'TEST')).toBe('0.0 TEST');
  });
});

describe('formatGasPrice', () => {
  it('should format gas price in gwei', () => {
    expect(formatGasPrice(parseUnits('1', 'gwei'))).toBe('1.00 gwei');
    expect(formatGasPrice(parseUnits('20', 'gwei'))).toBe('20.00 gwei');
    expect(formatGasPrice(parseUnits('150.5', 'gwei'))).toBe('150.50 gwei');
    expect(formatGasPrice(0n)).toBe('0.00 gwei');
  });
});
