import { describe, it, expect } from 'bun:test';
import { parseCharacter } from '../character';
import type { Character } from '../types';

describe('Character Validation Error Handling', () => {
  it('should throw detailed error when character validation fails with issues', () => {
    const invalidCharacter = {
      // Missing required 'name' field
      bio: ['Test bio'],
      settings: {},
    };

    expect(() => {
      parseCharacter(invalidCharacter);
    }).toThrow('Character validation failed');
  });

  it('should throw error with error message when validation fails without issues', () => {
    const invalidCharacter = {
      name: 123, // Invalid type
      bio: ['Test bio'],
      settings: {},
    } as Partial<Character> as Character;

    expect(() => {
      parseCharacter(invalidCharacter);
    }).toThrow();
  });

  it('should handle validation error with unknown error format', () => {
    // This tests the fallback error message handling
    const invalidCharacter = {
      // Invalid structure that will fail validation
      name: null,
      bio: null,
    } as Partial<Character> as Character;

    expect(() => {
      parseCharacter(invalidCharacter);
    }).toThrow();
  });

  it('should throw error when given string path input', () => {
    expect(() => {
      parseCharacter('/path/to/character.json');
    }).toThrow('Character path provided but must be loaded first');
  });

  it('should throw error for null input', () => {
    // Testing error handling with null input - intentionally invalid
    expect(() => {
      parseCharacter(null as Character);
    }).toThrow();
  });

  it('should throw error for undefined input', () => {
    // Testing error handling with undefined input - intentionally invalid
    expect(() => {
      parseCharacter(undefined as Character);
    }).toThrow();
  });
});
