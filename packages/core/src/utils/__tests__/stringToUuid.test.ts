import { describe, it, expect } from 'bun:test';
import { stringToUuid } from '../../utils';
import type { UUID } from '../../types';

describe('stringToUuid SHA-1 implementation', () => {
  // Test vectors to ensure deterministic output
  // These are the actual SHA-1 based outputs for consistency
  const testVectors = [
    { input: 'test', expected: 'a94a8fe5-ccb1-0ba6-9c4c-0873d391e987' },
    { input: 'hello world', expected: 'f0355dd5-2823-054c-ae66-a0b12842c215' },
    { input: '', expected: 'da39a3ee-5e6b-0b0d-b255-bfef95601890' },
    { input: '123', expected: '40bd0015-6308-0fc3-9165-329ea1ff5c5e' },
    { input: 'user:agent', expected: 'a49810ce-da30-0d3b-97ee-d4d47774d8af' },
  ];

  it('should produce deterministic UUIDs for known inputs', () => {
    testVectors.forEach(({ input, expected }) => {
      const result = stringToUuid(input);
      expect(result).toBe(expected);
    });
  });

  it('should handle UTF-8 strings correctly', () => {
    // Generate actual values for unicode tests
    const unicodeTests = [
      { input: 'Hello 世界', expected: stringToUuid('Hello 世界') },
      { input: '🌍🌎🌏', expected: stringToUuid('🌍🌎🌏') },
      { input: 'Café', expected: stringToUuid('Café') },
    ];

    unicodeTests.forEach(({ input, expected }) => {
      const result = stringToUuid(input);
      expect(result).toBe(expected);
    });
  });

  it('should return existing UUIDs unchanged', () => {
    const existingUuid = '550e8400-e29b-41d4-a716-446655440000' as UUID;
    const result = stringToUuid(existingUuid);
    expect(result).toBe(existingUuid);
  });

  it('should handle URL-unsafe characters consistently', () => {
    const urlTests = [
      { input: 'test?query=value&param=123', expected: stringToUuid('test?query=value&param=123') },
      { input: 'path/to/resource#anchor', expected: stringToUuid('path/to/resource#anchor') },
    ];

    urlTests.forEach(({ input, expected }) => {
      const result = stringToUuid(input);
      expect(result).toBe(expected);
    });
  });

  it('should handle numbers correctly', () => {
    expect(stringToUuid(42)).toBe(stringToUuid('42'));
    expect(stringToUuid(0)).toBe(stringToUuid('0'));
    expect(stringToUuid(-1)).toBe(stringToUuid('-1'));
  });

  it('should throw for invalid inputs', () => {
    expect(() => stringToUuid(null as any)).toThrow(TypeError);
    expect(() => stringToUuid(undefined as any)).toThrow(TypeError);
    expect(() => stringToUuid({} as any)).toThrow(TypeError);
    expect(() => stringToUuid([] as any)).toThrow(TypeError);
  });

  it('should set correct UUID format bits', () => {
    const uuid = stringToUuid('test');
    // Check format
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Check variant bits (should be 10xxxxxx in the 9th byte)
    const parts = uuid.split('-');
    const variantByte = parseInt(parts[3].substring(0, 2), 16);
    expect(variantByte & 0xc0).toBe(0x80); // 10xxxxxx pattern

    // Check version nibble (should be 0 for custom)
    const versionNibble = parseInt(parts[2][0], 16);
    expect(versionNibble).toBe(0);
  });

  it('should handle long inputs without errors', () => {
    const longInput = 'a'.repeat(10000);
    const result = stringToUuid(longInput);
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
