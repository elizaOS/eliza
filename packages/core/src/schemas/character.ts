import { z } from 'zod';
import type { Character } from '../types/agent';

// UUID validation schema
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID format');

// Message content schema matching the Content interface
const contentSchema = z
  .object({
    text: z.string().optional(),
    thought: z.string().optional(),
    actions: z.array(z.string()).optional(),
    providers: z.array(z.string()).optional(),
    source: z.string().optional(),
    target: z.string().optional(),
    url: z.string().optional(),
    inReplyTo: uuidSchema.optional(),
    attachments: z.array(z.any()).optional(),
    channelType: z.string().optional(),
  })
  .passthrough(); // Allow additional properties

// MessageExample schema
const messageExampleSchema = z.object({
  name: z.string(),
  content: contentSchema,
});

// DirectoryItem schema
const directoryItemSchema = z.object({
  directory: z.string(),
  shared: z.boolean().optional(),
});

// Knowledge item can be a string, object with path, or DirectoryItem
const knowledgeItemSchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    shared: z.boolean().optional(),
  }),
  directoryItemSchema,
]);

// TemplateType schema - can be string or function (we'll validate as string for JSON)
const templateTypeSchema = z.union([
  z.string(),
  z.function().optional(), // Functions won't be in JSON but allowed in runtime
]);

// Style configuration schema
const styleSchema = z
  .object({
    all: z.array(z.string()).optional(),
    chat: z.array(z.string()).optional(),
    post: z.array(z.string()).optional(),
  })
  .optional();

// Settings schema - flexible object
const settingsSchema = z.record(z.union([z.string(), z.boolean(), z.number(), z.any()])).optional();

// Secrets schema
const secretsSchema = z.record(z.union([z.string(), z.boolean(), z.number()])).optional();

// Main Character schema
export const characterSchema = z
  .object({
    id: uuidSchema.optional(),
    name: z.string().min(1, 'Character name is required'),
    username: z.string().optional(),
    system: z.string().optional(),
    templates: z.record(templateTypeSchema).optional(),
    bio: z.union([z.string(), z.array(z.string())]),
    messageExamples: z.array(z.array(messageExampleSchema)).optional(),
    postExamples: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    adjectives: z.array(z.string()).optional(),
    knowledge: z.array(knowledgeItemSchema).optional(),
    plugins: z.array(z.string()).optional(),
    settings: settingsSchema,
    secrets: secretsSchema,
    style: styleSchema,
  })
  .strict(); // Only allow known properties

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
 * @param data - Raw character data to validate
 * @returns Validation result with success flag and either data or error
 */
export function validateCharacter(data: unknown): CharacterValidationResult {
  const result = characterSchema.safeParse(data);

  if (result.success) {
    return {
      success: true,
      data: result.data as Character,
    };
  }

  return {
    success: false,
    error: {
      message: `Character validation failed: ${result.error.message}`,
      issues: result.error.issues,
    },
  };
}

/**
 * Safely parses JSON string and validates as character
 * @param jsonString - JSON string to parse and validate
 * @returns Validation result with success flag and either data or error
 */
export function parseAndValidateCharacter(jsonString: string): CharacterValidationResult {
  try {
    const parsed = JSON.parse(jsonString);
    return validateCharacter(parsed);
  } catch (error) {
    return {
      success: false,
      error: {
        message: `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown JSON parsing error'}`,
      },
    };
  }
}

/**
 * Type guard to check if data is a valid Character
 * @param data - Data to check
 * @returns True if data is a valid Character
 */
export function isValidCharacter(data: unknown): data is Character {
  return validateCharacter(data).success;
}
