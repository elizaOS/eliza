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
    throw new Error(`Character path provided but must be loaded first: ${input}`);
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
    ? validationResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
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
export function buildCharacterPlugins(
  env: Record<string, string | undefined> = process.env
): string[] {
  const plugins = [
    // Core plugins first
    '@elizaos/plugin-sql',

    // Text-only plugins (no embedding support)
    ...(env.ANTHROPIC_API_KEY?.trim() ? ['@elizaos/plugin-anthropic'] : []),
    ...(env.OPENROUTER_API_KEY?.trim() ? ['@elizaos/plugin-openrouter'] : []),

    // Embedding-capable plugins (before platform plugins per documented order)
    ...(env.OPENAI_API_KEY?.trim() ? ['@elizaos/plugin-openai'] : []),
    ...(env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ? ['@elizaos/plugin-google-genai'] : []),

    // Platform plugins
    ...(env.DISCORD_API_TOKEN?.trim() ? ['@elizaos/plugin-discord'] : []),
    ...(env.TWITTER_API_KEY?.trim() &&
    env.TWITTER_API_SECRET_KEY?.trim() &&
    env.TWITTER_ACCESS_TOKEN?.trim() &&
    env.TWITTER_ACCESS_TOKEN_SECRET?.trim()
      ? ['@elizaos/plugin-twitter']
      : []),
    ...(env.TELEGRAM_BOT_TOKEN?.trim() ? ['@elizaos/plugin-telegram'] : []),

    // Bootstrap plugin
    ...(() => {
      const ignore = env.IGNORE_BOOTSTRAP?.trim().toLowerCase();
      const shouldIgnore = ignore === 'true' || ignore === '1' || ignore === 'yes';
      return shouldIgnore ? [] : ['@elizaos/plugin-bootstrap'];
    })(),

    // Only include Ollama as fallback if no other LLM providers are configured
    ...(!env.ANTHROPIC_API_KEY?.trim() &&
    !env.OPENROUTER_API_KEY?.trim() &&
    !env.OPENAI_API_KEY?.trim() &&
    !env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
      ? ['@elizaos/plugin-ollama']
      : []),
  ];

  return plugins;
}
