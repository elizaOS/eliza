import { describe, test, expect } from 'bun:test';
import { parseCharacter, validateCharacterConfig, mergeCharacterDefaults } from '../character';
import type { Character } from '../../types';

describe('Character Config Functions', () => {
  describe('parseCharacter', () => {
    test('should return character object if already a Character', () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const parsed = parseCharacter(character);

      expect(parsed.name).toBe('TestChar');
    });

    test('should throw error when given a string path', () => {
      expect(() => {
        parseCharacter('/path/to/character.json');
      }).toThrow('Character path provided but must be loaded first');
    });

    test('should parse plain object to Character', () => {
      const obj = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {
          secrets: {},
        },
      };

      const parsed = parseCharacter(obj);

      expect(parsed.name).toBe('TestChar');
      expect(parsed.settings).toBeDefined();
    });
  });

  describe('validateCharacterConfig', () => {
    test('should return valid for character with name and bio', () => {
      const character: Character = {
        name: 'TestChar',
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = validateCharacterConfig(character);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should return invalid for character without name', () => {
      const character = {
        bio: ['Test bio'],
        settings: {},
      } as Character;

      const result = validateCharacterConfig(character);

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    });
  });

  describe('mergeCharacterDefaults', () => {
    test('should merge partial character with defaults', () => {
      const partial: Partial<Character> = {
        name: 'TestChar',
      };

      const merged = mergeCharacterDefaults(partial);

      expect(merged.name).toBe('TestChar');
      expect(merged.settings).toBeDefined();
      expect(merged.plugins).toBeDefined();
    });

    test('should use default name if not provided', () => {
      const partial: Partial<Character> = {};

      const merged = mergeCharacterDefaults(partial);

      expect(merged.name).toBe('Unnamed Character');
    });

    test('should not override provided values', () => {
      const partial: Partial<Character> = {
        name: 'TestChar',
        settings: { secrets: { key: 'value' } },
        plugins: ['plugin1'],
      };

      const merged = mergeCharacterDefaults(partial);

      expect(merged.name).toBe('TestChar');
      expect((merged.settings?.secrets as any)?.key).toBe('value');
      expect(merged.plugins).toHaveLength(1);
    });
  });
});
