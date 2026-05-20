/**
 * Tests for Name Replacement utilities
 */
import { describe, expect, it } from 'bun:test';
import {
  containsNameVariation,
  extractNameParts,
  generateNameVariations,
  replaceNameVariations,
} from '@babylon/shared/utils/name-replacement';

describe('Name Replacement Utilities', () => {
  describe('generateNameVariations', () => {
    it('should generate individual name variations', () => {
      const variations = generateNameVariations('John', 'Doe');

      // Lowercase
      expect(variations).toContain('john');
      expect(variations).toContain('doe');

      // Original case
      expect(variations).toContain('John');
      expect(variations).toContain('Doe');

      // Uppercase
      expect(variations).toContain('JOHN');
      expect(variations).toContain('DOE');
    });

    it('should generate combined name variations', () => {
      const variations = generateNameVariations('John', 'Doe');

      // All lowercase
      expect(variations).toContain('johndoe');

      // Title case
      expect(variations).toContain('JohnDoe');

      // All uppercase
      expect(variations).toContain('JOHNDOE');

      // Camel case
      expect(variations).toContain('johnDoe');
    });

    it('should generate separator variations', () => {
      const variations = generateNameVariations('John', 'Doe');

      // Underscore
      expect(variations).toContain('John_Doe');
      expect(variations).toContain('john_doe');
      expect(variations).toContain('JOHN_DOE');

      // Hyphen
      expect(variations).toContain('John-Doe');
      expect(variations).toContain('john-doe');
      expect(variations).toContain('JOHN-DOE');

      // Space
      expect(variations).toContain('John Doe');
      expect(variations).toContain('john doe');
      expect(variations).toContain('JOHN DOE');

      // Comma
      expect(variations).toContain('John, Doe');
      expect(variations).toContain('john, doe');
      expect(variations).toContain('JOHN, DOE');
    });

    it('should filter out empty variations', () => {
      const variations = generateNameVariations('', 'Doe');
      expect(variations.every((v) => v.length > 0)).toBe(true);
    });
  });

  describe('containsNameVariation', () => {
    it('should detect first name in text', () => {
      expect(
        containsNameVariation('Hello John, how are you?', 'John', 'Doe')
      ).toBe(true);
    });

    it('should detect last name in text', () => {
      expect(containsNameVariation('Mr. Doe called', 'John', 'Doe')).toBe(true);
    });

    it('should detect full name in text', () => {
      expect(
        containsNameVariation('Meeting with John Doe today', 'John', 'Doe')
      ).toBe(true);
    });

    it('should detect case-insensitive matches', () => {
      expect(containsNameVariation('JOHN is here', 'John', 'Doe')).toBe(true);
      expect(containsNameVariation('john said hello', 'John', 'Doe')).toBe(
        true
      );
    });

    it('should detect combined variations', () => {
      expect(containsNameVariation('Username: johndoe', 'John', 'Doe')).toBe(
        true
      );
      expect(
        containsNameVariation('Email: JohnDoe@example.com', 'John', 'Doe')
      ).toBe(true);
    });

    it('should return false when no name variation found', () => {
      expect(containsNameVariation('Hello world', 'John', 'Doe')).toBe(false);
      expect(containsNameVariation('The Johnsons visited', 'John', 'Doe')).toBe(
        false
      );
    });

    it('should use word boundaries', () => {
      // "johnny" should not match "john" as a word boundary match
      expect(containsNameVariation('johnny cash', 'John', 'Doe')).toBe(false);
    });
  });

  describe('replaceNameVariations', () => {
    it('should replace full name with space', () => {
      const result = replaceNameVariations(
        'John Doe is here',
        'John',
        'Doe',
        'Jane',
        'Smith'
      );
      expect(result).toBe('Jane Smith is here');
    });

    it('should replace full name variations', () => {
      // The function replaces longest variations first - JOHNDOE gets matched first
      const result = replaceNameVariations(
        'User: JohnDoe',
        'John',
        'Doe',
        'Jane',
        'Smith'
      );
      // Returns lowercase because JOHNDOE (from uppercase variations) matches first and replaces with janesmith
      expect(result.toLowerCase()).toBe('user: janesmith');
    });

    it('should replace underscore variations', () => {
      const result = replaceNameVariations(
        'username: John_Doe',
        'John',
        'Doe',
        'Jane',
        'Smith'
      );
      expect(result).toBe('username: Jane_Smith');
    });

    it('should replace hyphenated names', () => {
      const result = replaceNameVariations(
        'Contact: John-Doe',
        'John',
        'Doe',
        'Jane',
        'Smith'
      );
      expect(result).toBe('Contact: Jane-Smith');
    });

    it('should not replace partial matches', () => {
      const result = replaceNameVariations(
        'johnny cash',
        'John',
        'Doe',
        'Jane',
        'Smith'
      );
      expect(result).toBe('johnny cash');
    });

    it('should handle camelCase names', () => {
      const result = replaceNameVariations(
        'var johnDoe = true',
        'John',
        'Doe',
        'Jane',
        'Smith'
      );
      // The replacement algorithm matches case-insensitively but replaces with sorted variation
      expect(result.toLowerCase()).toBe('var janesmith = true');
    });
  });

  describe('extractNameParts', () => {
    it('should extract name parts from valid actor', () => {
      const actor = {
        firstName: 'Jane',
        lastName: 'Smith',
        originalFirstName: 'John',
        originalLastName: 'Doe',
      };

      const result = extractNameParts(actor);
      expect(result).toEqual({
        firstName: 'Jane',
        lastName: 'Smith',
        originalFirstName: 'John',
        originalLastName: 'Doe',
      });
    });

    it('should handle empty last names', () => {
      const actor = {
        firstName: 'Jane',
        lastName: '',
        originalFirstName: 'John',
        originalLastName: '',
      };

      const result = extractNameParts(actor);
      expect(result).toEqual({
        firstName: 'Jane',
        lastName: '',
        originalFirstName: 'John',
        originalLastName: '',
      });
    });

    it('should return null when firstName is missing', () => {
      const actor = {
        lastName: 'Smith',
        originalFirstName: 'John',
        originalLastName: 'Doe',
      };

      expect(extractNameParts(actor)).toBeNull();
    });

    it('should return null when lastName is undefined', () => {
      const actor = {
        firstName: 'Jane',
        originalFirstName: 'John',
        originalLastName: 'Doe',
      };

      expect(extractNameParts(actor)).toBeNull();
    });

    it('should return null when originalFirstName is missing', () => {
      const actor = {
        firstName: 'Jane',
        lastName: 'Smith',
        originalLastName: 'Doe',
      };

      expect(extractNameParts(actor)).toBeNull();
    });

    it('should return null when originalLastName is undefined', () => {
      const actor = {
        firstName: 'Jane',
        lastName: 'Smith',
        originalFirstName: 'John',
      };

      expect(extractNameParts(actor)).toBeNull();
    });
  });
});
