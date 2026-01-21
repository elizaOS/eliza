import { z } from "zod";
import type { Character } from "../types/agent";
import { ChannelType, ContentType } from "../types/primitives";
import type { JsonValue } from "../types/proto";

// UUID validation schema
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Invalid UUID format",
  )
  .describe("Unique identifier for the character in UUID format");

// Media attachment schema matching the Media type
export const mediaSchema = z
  .object({
    id: z.string().describe("Unique identifier for the media"),
    url: z.string().describe("URL of the media file"),
    title: z.string().optional().describe("Media title"),
    source: z.string().optional().describe("Media source"),
    description: z.string().optional().describe("Media description"),
    text: z
      .string()
      .optional()
      .describe("Text content associated with the media"),
    contentType: z
      .nativeEnum(ContentType)
      .optional()
      .describe("Type of media content"),
  })
  .loose()
  .describe("Media attachment with URL and metadata");

const jsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// Message content schema matching the Content interface
export const contentSchema = z
  .object({
    text: z
      .string()
      .optional()
      .describe("The main text content of the message"),
    thought: z
      .string()
      .optional()
      .describe("Internal thought process or reasoning"),
    actions: z
      .array(z.string())
      .optional()
      .describe("Actions to be taken in response"),
    providers: z
      .array(z.string())
      .optional()
      .describe("Data providers to use (e.g., KNOWLEDGE)"),
    source: z.string().optional().describe("Source of the content"),
    target: z.string().optional().describe("Target of the content"),
    url: z.string().optional().describe("Related URL"),
    inReplyTo: uuidSchema
      .optional()
      .describe("UUID of message this is replying to"),
    attachments: z
      .array(mediaSchema)
      .optional()
      .describe("Array of media attachments (images, videos, documents, etc.)"),
    channelType: z
      .enum(ChannelType)
      .optional()
      .describe("Type of channel this content is for"),
  })
  .passthrough()
  .describe("Content structure for messages in conversation examples");

// MessageExample schema
export const messageExampleSchema = z
  .object({
    name: z
      .string()
      .describe(
        "Name of the speaker (can use {{name1}} placeholder for dynamic names)",
      ),
    content: contentSchema,
  })
  .describe("A single message in a conversation example");

// DirectoryItem schema
export const knowledgeDirectorySchema = z
  .object({
    path: z.string().describe("Path to a knowledge directory"),
    shared: z
      .boolean()
      .optional()
      .describe("Whether this knowledge is shared across characters"),
  })
  .describe("Knowledge directory with optional shared flag");

const knowledgePathItemSchema = z.object({
  item: z.object({
    case: z.literal("path"),
    value: z.string(),
  }),
});

const knowledgeDirectoryItemSchema = z.object({
  item: z.object({
    case: z.literal("directory"),
    value: knowledgeDirectorySchema,
  }),
});

export const knowledgeItemSchema = z
  .union([knowledgePathItemSchema, knowledgeDirectoryItemSchema])
  .describe("Knowledge source item (path or directory)");

export const messageExampleGroupSchema = z
  .object({
    examples: z.array(messageExampleSchema),
  })
  .describe("Group of message examples");

const messageExamplesSchema = z
  .array(z.union([messageExampleGroupSchema, z.array(messageExampleSchema)]))
  .transform((groups) =>
    groups.map((group) => (Array.isArray(group) ? { examples: group } : group)),
  );

// Style configuration schema
export const styleSchema = z
  .object({
    all: z
      .array(z.string())
      .default([])
      .describe("Style guidelines applied to all types of responses"),
    chat: z
      .array(z.string())
      .default([])
      .describe("Style guidelines specific to chat/conversation responses"),
    post: z
      .array(z.string())
      .default([])
      .describe("Style guidelines specific to social media posts"),
  })
  .optional()
  .describe(
    "Style configuration defining how the character communicates across different contexts",
  );

// Settings schema - flexible object allowing any JSON-serializable values
const settingsKnownKeys = new Set([
  "shouldRespondModel",
  "useMultiStep",
  "maxMultistepIterations",
  "bootstrapDefllmoff",
  "bootstrapKeepResp",
  "providersTotalTimeoutMs",
  "maxWorkingMemoryEntries",
  "alwaysRespondChannels",
  "alwaysRespondSources",
  "defaultTemperature",
  "defaultMaxTokens",
  "defaultFrequencyPenalty",
  "defaultPresencePenalty",
  "disableBasicCapabilities",
  "enableExtendedCapabilities",
  "extra",
]);

export const settingsSchema = z
  .object({
    shouldRespondModel: z.string().optional(),
    useMultiStep: z.boolean().optional(),
    maxMultistepIterations: z.number().int().optional(),
    bootstrapDefllmoff: z.boolean().optional(),
    bootstrapKeepResp: z.boolean().optional(),
    providersTotalTimeoutMs: z.number().int().optional(),
    maxWorkingMemoryEntries: z.number().int().optional(),
    alwaysRespondChannels: z.string().optional(),
    alwaysRespondSources: z.string().optional(),
    defaultTemperature: z.number().optional(),
    defaultMaxTokens: z.number().int().optional(),
    defaultFrequencyPenalty: z.number().optional(),
    defaultPresencePenalty: z.number().optional(),
    disableBasicCapabilities: z.boolean().optional(),
    enableExtendedCapabilities: z.boolean().optional(),
    extra: z.record(z.string(), jsonValueSchema).optional(),
  })
  .passthrough()
  .transform((value) => {
    const entries = Object.entries(value) as Array<[string, JsonValue]>;
    const extraValues: Record<string, JsonValue> = {};
    const knownValues: Record<string, JsonValue> = {};

    for (const [key, entryValue] of entries) {
      if (settingsKnownKeys.has(key)) {
        knownValues[key] = entryValue;
      } else {
        extraValues[key] = entryValue;
      }
    }

    const mergedExtra =
      Object.keys(extraValues).length > 0
        ? {
            ...(knownValues.extra as Record<string, JsonValue> | undefined),
            ...extraValues,
          }
        : (knownValues.extra as Record<string, JsonValue> | undefined);

    if (mergedExtra) {
      return { ...knownValues, extra: mergedExtra };
    }

    return knownValues;
  })
  .optional()
  .describe(
    "Character-specific settings like avatar URL, preferences, and configuration",
  );

// Secrets schema
export const secretsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .default({})
  .describe(
    "Secret values and API keys (should not be committed to version control)",
  );

// Main Character schema
export const characterSchema = z
  .object({
    id: uuidSchema.optional().describe("Unique identifier for the character"),
    name: z
      .string()
      .min(1, "Character name is required")
      .describe('The name of the character (e.g., "Eliza")'),
    username: z
      .string()
      .optional()
      .describe("Username for the character on various platforms"),
    system: z
      .string()
      .optional()
      .describe(
        "System prompt that defines the character's core behavior and response style",
      ),
    templates: z
      .record(z.string(), z.string())
      .default({})
      .describe("Custom templates for generating different types of content"),
    bio: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) =>
        value === undefined ? [] : Array.isArray(value) ? value : [value],
      )
      .describe(
        "Character biography - accepts a single string or array of biographical points",
      ),
    messageExamples: messageExamplesSchema
      .default([])
      .describe(
        "Example conversations showing how the character responds in different scenarios",
      ),
    postExamples: z
      .array(z.string())
      .default([])
      .describe(
        "Example social media posts demonstrating the character's voice and topics",
      ),
    topics: z
      .array(z.string())
      .default([])
      .describe("Topics the character is knowledgeable about and engages with"),
    adjectives: z
      .array(z.string())
      .default([])
      .describe(
        "Adjectives that describe the character's personality and traits",
      ),
    knowledge: z
      .array(knowledgeItemSchema)
      .default([])
      .describe(
        "Knowledge sources (files, directories) the character can reference",
      ),
    plugins: z
      .array(z.string())
      .default([])
      .describe(
        'List of plugin package names to load (e.g., ["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap"] - these are commonly required)',
      ),
    settings: settingsSchema,
    secrets: secretsSchema,
    style: styleSchema,
    advancedPlanning: z
      .boolean()
      .optional()
      .describe(
        "Enable built-in advanced planning. When true, the runtime auto-loads planning capabilities.",
      ),
    advancedMemory: z
      .boolean()
      .optional()
      .describe(
        "Enable built-in advanced memory. When true, the runtime auto-loads memory capabilities.",
      ),
  })
  .strict()
  .describe(
    "Complete character definition including personality, behavior, and capabilities",
  );

// Validation result type
export interface CharacterValidationResult {
  success: boolean;
  data?: Character;
  error?: {
    message: string;
    issues?: z.ZodIssue[];
  };
}

/**
 * Safely validates character data using Zod schema
 */
export function validateCharacter(data: unknown): CharacterValidationResult {
  const result = characterSchema.safeParse(data);

  if (result.success) {
    return {
      success: true,
      data: result.data as Character,
    };
  }

  const errorMessage =
    result.error.issues?.[0]?.message ||
    result.error.toString() ||
    "Validation failed";
  return {
    success: false,
    error: {
      message: `Character validation failed: ${errorMessage}`,
      issues: result.error.issues,
    },
  };
}

/**
 * Safely parses JSON string and validates as character
 */
export function parseAndValidateCharacter(
  jsonString: string,
): CharacterValidationResult {
  try {
    const parsed = JSON.parse(jsonString);
    return validateCharacter(parsed);
  } catch (error) {
    return {
      success: false,
      error: {
        message: `Invalid JSON: ${error instanceof Error ? error.message : "Unknown JSON parsing error"}`,
      },
    };
  }
}

/**
 * Type guard to check if data is a valid Character
 */
export function isValidCharacter(data: unknown): data is Character {
  return validateCharacter(data).success;
}
