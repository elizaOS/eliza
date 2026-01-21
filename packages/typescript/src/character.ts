import { validateCharacter } from "./schemas/character";
import type {
  Character,
  CharacterSettings,
  KnowledgeSourceItem,
  MessageExample,
  MessageExampleGroup,
} from "./types";

type LegacyKnowledgeItem =
  | string
  | { path: string; shared?: boolean }
  | { directory: string; shared?: boolean }
  | KnowledgeSourceItem;

type MessageExamplesInput = MessageExampleGroup[] | MessageExample[][];

export interface CharacterInput {
  id?: string;
  name?: string;
  username?: string;
  system?: string;
  templates?: Record<string, string>;
  bio?: string | string[];
  messageExamples?: MessageExamplesInput;
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  knowledge?: LegacyKnowledgeItem[];
  plugins?: string[];
  settings?: CharacterSettings;
  secrets?: Record<string, string>;
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  advancedPlanning?: boolean;
  advancedMemory?: boolean;
}

interface NormalizedCharacterInput {
  id?: string;
  name?: string;
  username?: string;
  system?: string;
  templates: Record<string, string>;
  bio: string[];
  messageExamples: MessageExampleGroup[];
  postExamples: string[];
  topics: string[];
  adjectives: string[];
  knowledge: KnowledgeSourceItem[];
  plugins: string[];
  settings?: CharacterSettings;
  secrets: Record<string, string>;
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  advancedPlanning?: boolean;
  advancedMemory?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMessageExampleGroup = (
  value: MessageExampleGroup | MessageExample[],
): value is MessageExampleGroup =>
  isRecord(value) && "examples" in value && Array.isArray(value.examples);

function normalizeMessageExamples(
  input?: MessageExamplesInput,
): MessageExampleGroup[] {
  if (!input || input.length === 0) return [];
  const first = input[0];
  if (Array.isArray(first)) {
    const exampleSets = input as MessageExample[][];
    return exampleSets.map((examples) => ({ examples }));
  }
  if (isMessageExampleGroup(first)) {
    return input as MessageExampleGroup[];
  }
  return [];
}

function normalizeKnowledgeItem(
  item: LegacyKnowledgeItem,
): KnowledgeSourceItem | null {
  if (typeof item === "string") {
    return { item: { case: "path", value: item } };
  }
  if (!isRecord(item)) {
    return null;
  }
  if ("item" in item && isRecord(item.item)) {
    const caseValue = item.item.case;
    if (caseValue === "path" && typeof item.item.value === "string") {
      return item as KnowledgeSourceItem;
    }
    if (
      caseValue === "directory" &&
      isRecord(item.item.value) &&
      typeof item.item.value.path === "string"
    ) {
      return item as KnowledgeSourceItem;
    }
  }
  if ("path" in item && typeof item.path === "string") {
    return { item: { case: "path", value: item.path } };
  }
  if ("directory" in item && typeof item.directory === "string") {
    return {
      item: {
        case: "directory",
        value: {
          directory: item.directory,
          shared: typeof item.shared === "boolean" ? item.shared : undefined,
        },
      },
    };
  }
  return null;
}

export function normalizeCharacterInput(
  input: CharacterInput,
): NormalizedCharacterInput {
  const bioValue = input.bio;
  const normalizedBio =
    bioValue === undefined
      ? []
      : Array.isArray(bioValue)
        ? bioValue
        : [bioValue];

  const normalizedKnowledge = (input.knowledge ?? [])
    .map((item) => normalizeKnowledgeItem(item))
    .filter((item): item is KnowledgeSourceItem => item !== null);

  return {
    id: input.id,
    name: input.name,
    username: input.username,
    system: input.system,
    templates: input.templates ?? {},
    bio: normalizedBio,
    messageExamples: normalizeMessageExamples(input.messageExamples),
    postExamples: input.postExamples ?? [],
    topics: input.topics ?? [],
    adjectives: input.adjectives ?? [],
    knowledge: normalizedKnowledge,
    plugins: input.plugins ?? [],
    settings: input.settings ?? {},
    secrets: input.secrets ?? {},
    style: input.style,
    advancedPlanning: input.advancedPlanning,
    advancedMemory: input.advancedMemory,
  };
}

export function createCharacter(
  input: CharacterInput & { name: string },
): Character {
  return normalizeCharacterInput(input) as Character;
}

export function parseCharacter(
  input: string | object | Character | CharacterInput,
): Character {
  if (typeof input === "string") {
    throw new Error(
      `Character path provided but must be loaded first: ${input}`,
    );
  }

  if (typeof input === "object") {
    const normalized =
      input && typeof input === "object"
        ? normalizeCharacterInput(input as CharacterInput)
        : input;
    const validationResult = validateCharacter(normalized);

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

export function mergeCharacterDefaults(char: CharacterInput): Character {
  const normalized = normalizeCharacterInput(char);
  return {
    ...normalized,
    name: normalized.name || "Unnamed Character",
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
