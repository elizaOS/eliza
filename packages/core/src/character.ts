import { type Character } from './types';
import { validateCharacter } from './schemas/character';

/**
 * Parse character input from various formats (string path, object, or Character)
 * Uses the existing validateCharacter from schemas/character.ts
 * @param input - Character data in various formats
 * @returns Parsed Character object
 */
export function parseCharacter(input: string | object | Character): Character {
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
export function validateCharacterConfig(character: Character): {
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
export function mergeCharacterDefaults(char: Partial<Character>): Character {
  const defaults: Partial<Character> = {
    settings: {},
    plugins: [],
    bio: [],
  };

  return {
    ...defaults,
    ...char,
    name: char.name || 'Unnamed Character',
  } as Character;
}
