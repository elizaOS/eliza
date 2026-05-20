import { describe, expect, it } from 'bun:test';
import {
  calculatePerpPositionMarketValue,
  toNumber,
} from '@babylon/engine/client';

describe('toNumber', () => {
  it('returns the value when it is already a finite number', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(-3.14)).toBe(-3.14);
    expect(toNumber(0)).toBe(0);
  });

  it('parses numeric strings', () => {
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber('-7')).toBe(-7);
    expect(toNumber('0')).toBe(0);
  });

  it('returns fallback for non-numeric strings', () => {
    expect(toNumber('abc')).toBe(0);
    expect(toNumber('abc', 99)).toBe(99);
    expect(toNumber('')).toBe(0);
  });

  it('returns fallback for non-finite numbers', () => {
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toNumber(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('returns fallback for null, undefined, and objects', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber({})).toBe(0);
    expect(toNumber([])).toBe(0);
  });
});

describe('calculatePerpPositionMarketValue', () => {
  it('computes margin + unrealizedPnL for a standard leveraged position', () => {
    // size=100, leverage=5 → margin=20, unrealizedPnL=10 → value=30
    const value = calculatePerpPositionMarketValue({
      size: 100,
      leverage: 5,
      unrealizedPnL: 10,
    });
    expect(value).toBe(30);
  });

  it('handles negative unrealizedPnL (losing position)', () => {
    // size=100, leverage=5 → margin=20, unrealizedPnL=-15 → value=5
    const value = calculatePerpPositionMarketValue({
      size: 100,
      leverage: 5,
      unrealizedPnL: -15,
    });
    expect(value).toBe(5);
  });

  it('treats zero leverage as leverage=1 (no leverage)', () => {
    // size=50, leverage=0 (falls back to 1) → margin=50, unrealizedPnL=5 → value=55
    const value = calculatePerpPositionMarketValue({
      size: 50,
      leverage: 0,
      unrealizedPnL: 5,
    });
    expect(value).toBe(55);
  });

  it('treats negative leverage as leverage=1', () => {
    const value = calculatePerpPositionMarketValue({
      size: 40,
      leverage: -2,
      unrealizedPnL: 0,
    });
    expect(value).toBe(40);
  });

  it('handles negative size (short position) by taking abs for margin', () => {
    // size=-100, leverage=5 → margin=abs(-100/5)=20, unrealizedPnL=10 → value=30
    const value = calculatePerpPositionMarketValue({
      size: -100,
      leverage: 5,
      unrealizedPnL: 10,
    });
    expect(value).toBe(30);
  });

  it('coerces string inputs from DB/JSON payloads', () => {
    const value = calculatePerpPositionMarketValue({
      size: '200',
      leverage: '10',
      unrealizedPnL: '-5',
    });
    // margin=abs(200/10)=20, unrealizedPnL=-5 → value=15
    expect(value).toBe(15);
  });

  it('returns 0 when all inputs are zero', () => {
    const value = calculatePerpPositionMarketValue({
      size: 0,
      leverage: 0,
      unrealizedPnL: 0,
    });
    expect(value).toBe(0);
  });

  it('returns 0 for persisted perp positions above the exposure cap', () => {
    const value = calculatePerpPositionMarketValue({
      size: 45_002_000,
      leverage: 1,
      unrealizedPnL: 3_719_032_361.1754107,
    });
    expect(value).toBe(0);
  });
});
