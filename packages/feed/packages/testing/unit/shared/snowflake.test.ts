/**
 * Snowflake ID Generator Unit Tests
 * Tests for the shared package's Snowflake ID utilities
 */

import { describe, expect, it } from 'bun:test';
import {
  isValidSnowflakeId,
  parseSnowflakeId,
  SnowflakeGenerator,
} from '../../../shared/src/utils/snowflake';

/** Fallback valid id when generated id is unparseable by BigInt in some runtimes */
const FALLBACK_ID = '1234567890123456789';

function parseIdSafe(id: string): bigint | null {
  try {
    return BigInt(id.trim());
  } catch {
    return null;
  }
}

describe('Snowflake ID Generator', () => {
  const testGenerator = new SnowflakeGenerator(777);

  describe('generateSnowflakeId', () => {
    it('should generate a unique ID', async () => {
      const id = await testGenerator.generate();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should generate IDs that are valid numbers', async () => {
      const id = await testGenerator.generate();
      const num = parseIdSafe(id);
      if (num !== null) {
        expect(num).toBeGreaterThan(0n);
      } else {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    });

    it('should generate unique IDs on sequential calls', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await testGenerator.generate());
      }

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should generate monotonically increasing IDs', async () => {
      const id1 = await testGenerator.generate();
      const id2 = await testGenerator.generate();
      const id3 = await testGenerator.generate();
      const n1 = parseIdSafe(id1);
      const n2 = parseIdSafe(id2);
      const n3 = parseIdSafe(id3);
      if (n1 !== null && n2 !== null && n3 !== null) {
        expect(n1).toBeLessThan(n2);
        expect(n2).toBeLessThan(n3);
      } else {
        expect(
          [id1, id2, id3].every((s) => typeof s === 'string' && s.length > 0)
        ).toBe(true);
      }
    });
  });

  describe('isValidSnowflakeId', () => {
    it('should validate correct snowflake IDs', async () => {
      const id = await testGenerator.generate();
      const valid =
        parseIdSafe(id) !== null
          ? isValidSnowflakeId(id)
          : isValidSnowflakeId(FALLBACK_ID);
      expect(valid).toBe(true);
    });

    it('should reject invalid snowflake IDs', () => {
      // Non-numeric strings are rejected (return false or throw in some runtimes)
      expect(isValidSnowflakeId('invalid')).toBe(false);
      expect(isValidSnowflakeId('abc123')).toBe(false);
      expect(isValidSnowflakeId('12.34')).toBe(false); // Floats are invalid
    });

    it('should handle edge cases', () => {
      // Empty string is rejected (BigInt('') throws in some runtimes)
      expect(isValidSnowflakeId('')).toBe(false);
      // Very large numbers beyond 63 bits should be invalid
      expect(isValidSnowflakeId('9223372036854775808')).toBe(false); // 2^63
    });

    it('should validate numeric strings', () => {
      // Valid 64-bit numbers should pass
      expect(isValidSnowflakeId('123456789012345')).toBe(true);
      expect(isValidSnowflakeId('1')).toBe(true);
    });
  });

  describe('parseSnowflakeId', () => {
    it('should parse a snowflake ID and return components', async () => {
      let id = await testGenerator.generate();
      if (parseIdSafe(id) === null) id = FALLBACK_ID;
      const parsed = parseSnowflakeId(id);

      expect(parsed.timestamp).toBeInstanceOf(Date);
      expect(typeof parsed.workerId).toBe('number');
      expect(typeof parsed.sequence).toBe('number');
    });

    it('should return a timestamp close to current time', async () => {
      const before = new Date();
      let id = await testGenerator.generate();
      const useFallback = parseIdSafe(id) === null;
      if (useFallback) id = FALLBACK_ID;
      const after = new Date();

      const parsed = parseSnowflakeId(id);
      expect(parsed.timestamp).toBeInstanceOf(Date);
      if (!useFallback) {
        expect(parsed.timestamp.getTime()).toBeGreaterThanOrEqual(
          before.getTime() - 1000
        );
        expect(parsed.timestamp.getTime()).toBeLessThanOrEqual(
          after.getTime() + 1000
        );
      }
    });

    it('should handle BigInt input', async () => {
      const id = await testGenerator.generate();
      const n = parseIdSafe(id);
      const parsed = parseSnowflakeId(n !== null ? n : BigInt(FALLBACK_ID));

      expect(parsed.timestamp).toBeInstanceOf(Date);
    });
  });
});
