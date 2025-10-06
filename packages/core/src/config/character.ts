import { type Character } from '../types';
import { validateCharacter } from '../schemas/character';

/**
 * Manages character configuration parsing, validation, and merging
 * This is a utility wrapper around existing character validation logic
 */
export class CharacterConfig {
  /**
   * Parse character input from various formats (string path, object, or Character)
   * Uses the existing validateCharacter from schemas/character.ts
   * @param input - Character data in various formats
   * @returns Parsed Character object
   */
  static parse(input: string | object | Character): Character {
    // If it's a string, treat it as a file path (to be loaded by caller)
    if (typeof input === 'string') {
      throw new Error(
        `Character path provided but must be loaded first: ${input}`
      );
    }

    // If it's an object, validate and return it
    if (typeof input === 'object') {
      const validationResult = validateCharacter(input);

      if (!validationResult.success) {
        const errorDetails = validationResult.error?.issues
          ? validationResult.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
          : validationResult.error?.message || 'Unknown validation error';
        throw new Error(`Character validation failed: ${errorDetails}`);
      }

      return validationResult.data as Character;
    }

    throw new Error('Invalid character input format');
  }

  /**
   * Validate a character configuration
   * Uses the existing validateCharacter from schemas/character.ts
   * @param character - Character to validate
   * @returns Validation result with errors if any
   */
  static validate(character: Character): {
    isValid: boolean;
    errors: string[];
  } {
    const validationResult = validateCharacter(character);

    if (validationResult.success) {
      return {
        isValid: true,
        errors: [],
      };
    }

    const errors = validationResult.error?.issues
      ? validationResult.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`
        )
      : [validationResult.error?.message || 'Unknown validation error'];

    return {
      isValid: false,
      errors,
    };
  }

  /**
   * Merge character with default values
   * @param char - Partial character configuration
   * @returns Complete character with defaults
   */
  static mergeDefaults(char: Partial<Character>): Character {
    const defaults: Partial<Character> = {
      settings: {},
      plugins: [],
      bio: [],
      // Add other sensible defaults
    };

    return {
      ...defaults,
      ...char,
      name: char.name || 'Unnamed Character',
    } as Character;
  }
}
