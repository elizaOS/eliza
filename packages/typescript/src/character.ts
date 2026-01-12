import { validateCharacter } from "./schemas/character";
import type { Character } from "./types";

export function parseCharacter(input: string | object | Character): Character {
  if (typeof input === "string") {
    throw new Error(
      `Character path provided but must be loaded first: ${input}`,
    );
  }

  if (typeof input === "object") {
    const validationResult = validateCharacter(input);

    if (!validationResult.success) {
      const validationError = validationResult.error;
      const errorDetails = validationError?.issues
        ? validationError.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        : validationError?.message || "Unknown validation error";
      throw new Error(`Character validation failed: ${errorDetails}`);
    }

    return validationResult.data as Character;
  }

  throw new Error("Invalid character input format");
}

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

  const validationError = validationResult.error;
  const errors = validationError?.issues
    ? validationError.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      )
    : [validationError?.message || "Unknown validation error"];

  return {
    isValid: false,
    errors,
  };
}

export function mergeCharacterDefaults(char: Partial<Character>): Character {
  const defaults: Partial<Character> = {
    settings: {},
    plugins: [],
    bio: [],
  };

  return {
    ...defaults,
    ...char,
    name: char.name || "Unnamed Character",
  } as Character;
}

export function buildCharacterPlugins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const plugins = [
    "@elizaos/plugin-sql",
    ...(env.ANTHROPIC_API_KEY?.trim() ? ["@elizaos/plugin-anthropic"] : []),
    ...(env.OPENROUTER_API_KEY?.trim() ? ["@elizaos/plugin-openrouter"] : []),
    ...(env.OPENAI_API_KEY?.trim() ? ["@elizaos/plugin-openai"] : []),
    ...(env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
      ? ["@elizaos/plugin-google-genai"]
      : []),
    ...(env.DISCORD_API_TOKEN?.trim() ? ["@elizaos/plugin-discord"] : []),
    ...(env.X_API_KEY?.trim() &&
    env.X_API_SECRET &&
    env.X_API_SECRET.trim() &&
    env.X_ACCESS_TOKEN &&
    env.X_ACCESS_TOKEN.trim() &&
    env.X_ACCESS_TOKEN_SECRET &&
    env.X_ACCESS_TOKEN_SECRET.trim()
      ? ["@elizaos/plugin-x"]
      : []),
    ...(env.TELEGRAM_BOT_TOKEN?.trim() ? ["@elizaos/plugin-telegram"] : []),
    ...(() => {
      const ignore = env.IGNORE_BOOTSTRAP?.trim().toLowerCase();
      const shouldIgnore =
        ignore === "true" || ignore === "1" || ignore === "yes";
      return shouldIgnore ? [] : ["@elizaos/plugin-bootstrap"];
    })(),
    ...(!env.ANTHROPIC_API_KEY?.trim() &&
    !env.OPENROUTER_API_KEY?.trim() &&
    !env.OPENAI_API_KEY?.trim() &&
    !env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
      ? ["@elizaos/plugin-ollama"]
      : []),
  ];

  return plugins;
}
