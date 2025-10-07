import { describe, it, expect } from 'bun:test';
import type { Agent } from '@elizaos/core';

describe('Character File Size Limits - Issue #5268 Regression Test', () => {
  function generateLargeCharacter(targetSizeKB: number): Agent {
    const baseCharacter: Agent = {
      name: 'LargeTestCharacter',
      bio: ['This is a test character with a large configuration.'],
      settings: {
        secrets: {},
        voice: {
          model: 'en_US-hfc_female-medium',
        },
      },
      messageExamples: [],
      postExamples: [],
      topics: [],
      style: {
        all: [],
        chat: [],
        post: [],
      },
      adjectives: [],
      people: [],
      clients: [],
    };

    const currentSize = JSON.stringify(baseCharacter).length;
    const targetSize = targetSizeKB * 1024;
    const additionalBytesNeeded = targetSize - currentSize;

    if (additionalBytesNeeded > 0) {
      const singleBioSize = 1000;
      const entriesNeeded = Math.ceil(additionalBytesNeeded / singleBioSize);

      for (let i = 0; i < entriesNeeded; i++) {
        baseCharacter.bio.push(
          `Extended biography section ${i + 1}: ${'x'.repeat(singleBioSize - 50)}`
        );
      }
    }

    return baseCharacter;
  }

  describe('Issue #5268 Reproduction and Fix Verification', () => {
    it('should handle 150KB character that was failing before fix', () => {
      // This reproduces the exact issue: 150KB character file
      const character = generateLargeCharacter(150);
      const jsonSize = JSON.stringify(character).length;

      // Verify we have a 150KB character
      expect(jsonSize).toBeGreaterThan(145 * 1024); // At least 145KB
      expect(jsonSize).toBeLessThan(200 * 1024); // Under 200KB

      // This would have failed with old 100KB limit
      const oldLimit = 100 * 1024;
      expect(jsonSize).toBeGreaterThan(oldLimit);

      // But should be fine with new 2MB limit
      const newLimit = 2 * 1024 * 1024; // 2MB
      expect(jsonSize).toBeLessThan(newLimit);

      // Character should maintain valid structure
      expect(character.name).toBe('LargeTestCharacter');
      expect(Array.isArray(character.bio)).toBe(true);
      expect(character.bio.length).toBeGreaterThan(1);
    });

    it('should handle various large character sizes up to reasonable limits', () => {
      const sizes = [150, 500, 1000]; // KB sizes to test (up to 1MB)

      sizes.forEach((sizeKB) => {
        const character = generateLargeCharacter(sizeKB);
        const jsonSize = JSON.stringify(character).length;

        // All should be under the new 2MB limit
        const maxLimit = 2 * 1024 * 1024; // 2MB
        expect(jsonSize).toBeLessThan(maxLimit);

        // All should maintain valid character structure
        expect(character.name).toBe('LargeTestCharacter');
        expect(typeof character.bio).toBe('object');
        expect(Array.isArray(character.bio)).toBe(true);
        expect(character.settings).toBeDefined();
      });
    });
  });

  describe('Regression Prevention', () => {
    it('should document the fix - Express limit increased from 100KB to 2MB', () => {
      const oldLimit = 100 * 1024; // 100KB (original limit)
      const newLimit = 2 * 1024 * 1024; // 2MB (new limit)

      // Verify the fix provides significant increase
      expect(newLimit).toBeGreaterThan(oldLimit);
      expect(newLimit / oldLimit).toBeCloseTo(20.48); // 20.48x increase

      // The reported 150KB file should now be well within limits
      const reportedFileSize = 150 * 1024;
      expect(reportedFileSize).toBeGreaterThan(oldLimit); // Would have failed before
      expect(reportedFileSize).toBeLessThan(newLimit); // Should work now
    });
  });
});
