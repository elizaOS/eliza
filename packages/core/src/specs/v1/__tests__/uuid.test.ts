import { describe, expect, it } from 'bun:test';
import { asUUID, UUID } from '../uuid';

describe('UUID Module', () => {
  describe('UUID Type', () => {
    it('should define UUID as a string type with specific format', () => {
      // This is a type-level test, no runtime assertions necessary
      // Just checking that we can assign a properly formatted string to the UUID type
      const validUUID: UUID = '123e4567-e89b-12d3-a456-426614174000';
      expect(validUUID).toBeDefined();
      expect(typeof validUUID).toBe('string');
    });
  });

  describe('asUUID function', () => {
    it('should accept valid UUIDs and normalize to lowercase', () => {
      const validUUIDStrings = [
        '123e4567-e89b-12d3-a456-426614174000',
        'a1a2a3a4-b1b2-c1c2-d1d2-d3d4d5d6d7d8',
        '00000000-0000-0000-0000-000000000000',
        'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', // Mixed case test
        'AbCdEf12-3456-7890-aBcD-eF1234567890', // Mixed case test
      ];

      validUUIDStrings.forEach((validUUID) => {
        const result = asUUID(validUUID);
        // The function should normalize to lowercase
        expect(result).toBe(validUUID.toLowerCase() as UUID);
      });
    });

    it('should reject invalid UUIDs', () => {
      const invalidUUIDStrings = [
        '', // Empty string
        '123e4567', // Too short
        '123e4567-e89b-12d3-a456-4266141740001', // Too long
        '123e4567-e89b-12d3-a456-42661417400g', // Invalid character
        '123e4567_e89b_12d3_a456_426614174000', // Invalid separator
        '123e4567-e89b-12d3-a456-4266-14174000', // Wrong format (too many segments)
        '123e4567-e89b-12d3-a456', // Missing segment
        null, // Null
        undefined, // Undefined
        // Additional cases to test edge cases
        'gggggggg-gggg-gggg-gggg-gggggggggggg', // All non-hex characters
        '123456789-1234-1234-1234-123456789012', // Too many digits in first group
      ];

      invalidUUIDStrings.forEach((invalidUUID) => {
        expect(() => asUUID(invalidUUID as any)).toThrow('Invalid UUID format');
      });
    });

    it('should convert uppercase UUIDs to lowercase', () => {
      const uppercaseUUID = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
      const expectedLowercase = 'abcdef12-3456-7890-abcd-ef1234567890';

      const result = asUUID(uppercaseUUID);
      expect(result).toBe(expectedLowercase);
    });

    it('should return a branded UUID type', () => {
      const uuidStr = '123e4567-e89b-12d3-a456-426614174000';
      const result = asUUID(uuidStr);

      // This is a type-level test, but we can still check the runtime behavior
      expect(result).toBe(uuidStr); // Already lowercase, so no change
      expect(typeof result).toBe('string');
    });

    it('should handle UUIDs with version and variant bits correctly', () => {
      // UUID version 4 (random) has a specific format for the 13th character (should be 4)
      // and 17th character (should be 8, 9, a, or b)
      const uuidV4 = '123e4567-e89b-42d3-a456-426614174000';
      const result = asUUID(uuidV4);
      expect(result).toBe(uuidV4);
      expect(result.charAt(14)).toBe('4'); // 13th character is position 14 in the string (0-indexed)
    });
  });
});
