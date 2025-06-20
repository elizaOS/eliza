import { describe, it, expect } from 'bun:test';
import { computePca } from './pca';

describe('computePca', () => {
  it('projects 3D vectors to 2D deterministically', () => {
    const data = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const result = computePca(data, 2);
    expect(result.length).toBe(3);
    // first vector should have positive coordinates
    expect(result[0][0]).toBeGreaterThan(0);
    expect(result[0][1]).toBeDefined();
  });
});
