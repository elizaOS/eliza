/**
 * Cosine Similarity — Unit Tests
 *
 * Tests the pure math function used by both the grounding validator (single
 * embeddings) and the consolidator (pairwise clustering). Since this function
 * underpins all semantic similarity checks, correctness matters.
 */

import { describe, expect, test } from 'bun:test';
import { cosineSimilarity } from '@feed/engine';

describe('cosineSimilarity', () => {
  test('identical vectors return 1', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  test('opposite vectors return -1', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
  });

  test('orthogonal vectors return 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  test('parallel vectors with different magnitudes return 1', () => {
    const a = [3, 4];
    const b = [6, 8]; // Same direction, 2x magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  test('45-degree angle returns ~0.707', () => {
    const a = [1, 0];
    const b = [1, 1]; // 45 degrees from a
    // cos(45°) = 1/√2 ≈ 0.7071
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 4);
  });

  test('empty vectors return 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test('mismatched vector lengths return 0', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test('zero vector returns 0 (division by zero guard)', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test('both zero vectors return 0', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test('high-dimensional vectors compute correctly', () => {
    // 1536 dimensions (OpenAI text-embedding-3-small output size)
    const dim = 1536;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));

    const result = cosineSimilarity(a, b);
    // Slightly shifted sine waves should be very similar
    expect(result).toBeGreaterThan(0.95);
    expect(result).toBeLessThanOrEqual(1);
  });

  test('negative values are handled correctly', () => {
    const a = [-1, -2, -3];
    const b = [-2, -4, -6]; // Same direction (parallel), 2x magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  test('mixed positive/negative values', () => {
    const a = [1, -1, 0];
    const b = [-1, 1, 0]; // Opposite direction
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
  });

  test('result is always in [-1, 1] range for random vectors', () => {
    // Generate 20 random vector pairs and verify range
    for (let trial = 0; trial < 20; trial++) {
      const dim = 100;
      const a = Array.from({ length: dim }, () => Math.random() * 2 - 1);
      const b = Array.from({ length: dim }, () => Math.random() * 2 - 1);

      const result = cosineSimilarity(a, b);
      expect(result).toBeGreaterThanOrEqual(-1 - 1e-10);
      expect(result).toBeLessThanOrEqual(1 + 1e-10);
    }
  });

  test('symmetry: sim(a,b) === sim(b,a)', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];

    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  test('single-element vectors', () => {
    expect(cosineSimilarity([5], [3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([5], [-3])).toBeCloseTo(-1, 10);
  });
});
