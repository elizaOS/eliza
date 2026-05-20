/**
 * World Context Examples Tests
 */

import { describe, expect, test } from 'bun:test';
import {
  getFullRealityGrounding,
  getMinimalRealityGrounding,
  getRealityGrounding,
  getWorldEventExamples,
} from '@babylon/engine';

describe('World Context Examples Integration', () => {
  test('getWorldEventExamples should return formatted examples string', async () => {
    const examples = await getWorldEventExamples();

    expect(examples).toBeString();
    expect(examples).toContain(
      '=== WORLD EVENT EXAMPLES (FOR STYLE AND TONE) ==='
    );

    // Check that it contains content lines (not checking for bullets as format changed)
    const lines = examples
      .split('\n')
      .filter(
        (l) => l.trim().length > 0 && !l.startsWith('=') && !l.startsWith('#')
      );
    expect(lines.length).toBeGreaterThan(20);
  });

  test('getRealityGrounding should NOT contain world event examples', async () => {
    const reality = await getRealityGrounding();

    expect(reality).toBeString();
    expect(reality).toContain('=== REALITY GROUNDING');
    expect(reality).not.toContain('=== WORLD EVENT EXAMPLES');

    // It should not contain typical satirical examples from the world events file
    // (unless they are also in reality grounding, which they shouldn't be)
    // We can check for the header specifically which is the safest check.
  });

  test('getMinimalRealityGrounding should NOT contain world event examples', async () => {
    const reality = await getMinimalRealityGrounding();

    expect(reality).toBeString();
    expect(reality).toContain('DATE:');
    expect(reality).not.toContain('=== WORLD EVENT EXAMPLES');
  });

  test('getFullRealityGrounding should NOT contain world event examples', async () => {
    const reality = await getFullRealityGrounding();

    expect(reality).toBeString();
    expect(reality).toContain('=== CURRENT DATE:');
    expect(reality).not.toContain('=== WORLD EVENT EXAMPLES');
  });

  test('World events should be distinct from reality grounding', async () => {
    const events = await getWorldEventExamples();
    const reality = await getRealityGrounding();

    // Ensure they are different content
    expect(events).not.toEqual(reality);

    // Ensure events are satirical (checking for a known keyword from the file if possible,
    // but since it's random 20, we rely on structure)
    expect(events).toContain('-');
  });
});
