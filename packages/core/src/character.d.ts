import { type Character } from './types';
/**
 * Parse character input from various formats (string path, object, or Character)
 * Uses the existing validateCharacter from schemas/character.ts
 * @param input - Character data in various formats
 * @returns Parsed Character object
 */
export declare function parseCharacter(input: string | object | Character): Character;
/**
 * Validate a character configuration
 * Uses the existing validateCharacter from schemas/character.ts
 * @param character - Character to validate
 * @returns Validation result with errors if any
 */
export declare function validateCharacterConfig(character: Character): {
    isValid: boolean;
    errors: string[];
};
/**
 * Merge character with default values
 * @param char - Partial character configuration
 * @returns Complete character with defaults
 */
export declare function mergeCharacterDefaults(char: Partial<Character>): Character;
/**
 * Build ordered plugin list based on available environment variables
 *
 * Plugin loading order:
 * 1. Core plugins (@elizaos/plugin-sql)
 * 2. Text-only LLM plugins (no embedding support)
 * 3. Embedding-capable LLM plugins
 * 4. Platform plugins (Discord, Twitter, Telegram)
 * 5. Bootstrap plugin (unless IGNORE_BOOTSTRAP is set)
 * 6. Ollama fallback (only if no other LLM providers configured)
 *
 * @param env - Environment object to check for API keys (defaults to process.env)
 * @returns Ordered array of plugin names
 */
export declare function buildCharacterPlugins(env?: Record<string, string | undefined>): string[];
//# sourceMappingURL=character.d.ts.map