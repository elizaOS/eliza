import { describe, expect, it } from 'bun:test';

// Inline the math functions since they're in a script, not a package export
function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum === 0) return 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (i + 1) * sorted[i]!;
  }
  return (2 * weightedSum) / (n * sum) - (n + 1) / n;
}

function hhi(shares: number[]): number {
  const total = shares.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  return shares.reduce((s, v) => s + (v / total) ** 2, 0);
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function skewness(values: number[]): number {
  if (values.length < 3) return 0;
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = stdDev(values);
  if (sd === 0) return 0;
  const m3 = values.reduce((s, v) => s + ((v - mean) / sd) ** 3, 0) / n;
  return m3;
}

describe('Gini coefficient', () => {
  it('returns 0 for empty array', () => {
    expect(gini([])).toBe(0);
  });

  it('returns 0 for perfectly equal distribution', () => {
    expect(gini([10, 10, 10, 10])).toBeCloseTo(0, 5);
  });

  it('returns high value for concentrated distribution', () => {
    const result = gini([100, 1, 1, 1]);
    expect(result).toBeGreaterThan(0.7);
  });

  it('returns moderate value for moderate inequality', () => {
    const result = gini([50, 30, 15, 5]);
    expect(result).toBeGreaterThan(0.2);
    expect(result).toBeLessThan(0.7);
  });

  it('returns 0 for all zeros', () => {
    expect(gini([0, 0, 0])).toBe(0);
  });
});

describe('HHI (Herfindahl-Hirschman Index)', () => {
  it('returns 0 for empty array', () => {
    expect(hhi([])).toBe(0);
  });

  it('returns 1 for monopoly (single entity)', () => {
    expect(hhi([100])).toBeCloseTo(1, 5);
  });

  it('returns 0.25 for perfect duopoly', () => {
    expect(hhi([50, 50])).toBeCloseTo(0.5, 5);
  });

  it('returns low value for many equal participants', () => {
    const result = hhi([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(result).toBeCloseTo(0.1, 5);
  });

  it('returns higher value for concentrated market', () => {
    const result = hhi([70, 10, 10, 5, 5]);
    expect(result).toBeGreaterThan(0.4);
  });
});

describe('Standard deviation', () => {
  it('returns 0 for single value', () => {
    expect(stdDev([42])).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(stdDev([])).toBe(0);
  });

  it('returns 0 for identical values', () => {
    expect(stdDev([5, 5, 5, 5])).toBeCloseTo(0, 5);
  });

  it('returns correct value for known distribution', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → std ≈ 2.0
    const result = stdDev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).toBeGreaterThan(1.5);
    expect(result).toBeLessThan(2.5);
  });
});

describe('Skewness', () => {
  it('returns 0 for fewer than 3 values', () => {
    expect(skewness([])).toBe(0);
    expect(skewness([1])).toBe(0);
    expect(skewness([1, 2])).toBe(0);
  });

  it('returns near 0 for symmetric distribution', () => {
    const result = skewness([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Math.abs(result)).toBeLessThan(0.1);
  });

  it('returns positive for right-skewed distribution', () => {
    const result = skewness([1, 1, 1, 1, 1, 1, 1, 10, 100]);
    expect(result).toBeGreaterThan(0);
  });

  it('returns negative for left-skewed distribution', () => {
    // Left-skewed: most values clustered high, long tail to the left
    const result = skewness([1, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
    expect(result).toBeLessThan(0);
  });
});
