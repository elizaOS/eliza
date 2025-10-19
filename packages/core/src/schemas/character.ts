import { z } from 'zod';
import type { Character } from '../types/agent';
import { ChannelType } from '../types/environment';
import { ContentType } from '../types/primitives';

// UUID validation schema
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID format')
  .describe('Unique identifier for the character in UUID format');

// Media attachment schema matching the Media type
export const mediaSchema = z
  .object({
    id: z.string().describe('Unique identifier for the media'),
    url: z.string().describe('URL of the media file'),
    title: z.string().optional().describe('Media title'),
    source: z.string().optional().describe('Media source'),
    description: z.string().optional().describe('Media description'),
    text: z.string().optional().describe('Text content associated with the media'),
    contentType: z.nativeEnum(ContentType).optional().describe('Type of media content'),
  })
  .loose()
  .describe('Media attachment with URL and metadata');

// Message content schema matching the Content interface
export const contentSchema = z
  .object({
    text: z.string().optional().describe('The main text content of the message'),
    thought: z.string().optional().describe('Internal thought process or reasoning'),
    actions: z.array(z.string()).optional().describe('Actions to be taken in response'),
    providers: z.array(z.string()).optional().describe('Data providers to use (e.g., KNOWLEDGE)'),
    source: z.string().optional().describe('Source of the content'),
    target: z.string().optional().describe('Target of the content'),
    url: z.string().optional().describe('Related URL'),
    inReplyTo: uuidSchema.optional().describe('UUID of message this is replying to'),
    attachments: z
      .array(mediaSchema)
      .optional()
      .describe('Array of media attachments (images, videos, documents, etc.)'),
    channelType: z.enum(ChannelType).optional().describe('Type of channel this content is for'),
  })
  .catchall(z.unknown()) // Allow additional dynamic properties per Content interface
  .describe('Content structure for messages in conversation examples');

// MessageExample schema
export const messageExampleSchema = z
  .object({
    name: z
      .string()
      .describe('Name of the speaker (can use {{name1}} placeholder for dynamic names)'),
    content: contentSchema,
  })
  .describe('A single message in a conversation example');

// DirectoryItem schema
export const directoryItemSchema = z
  .object({
    directory: z.string().describe('Path to a directory containing knowledge files'),
    shared: z.boolean().optional().describe('Whether this knowledge is shared across characters'),
  })
  .describe('Directory-based knowledge source');

// Knowledge item can be a string, object with path, or DirectoryItem
export const knowledgeItemSchema = z
  .union([
    z.string().describe('File path to a knowledge document'),
    z.object({
      path: z.string().describe('Path to a knowledge file'),
      shared: z.boolean().optional().describe('Whether this knowledge is shared across characters'),
    }),
    directoryItemSchema,
  ])
  .describe('Knowledge source - can be a file path, file object, or directory');

// TemplateType schema - can be string or function (we'll validate as string for JSON)
export const templateTypeSchema = z
  .union([
    z.string().describe('Template string with placeholders'),
    z.function().optional(), // Functions won't be in JSON but allowed in runtime
  ])
  .describe('Template for generating text - can be a string template or function');

// Style configuration schema
export const styleSchema = z
  .object({
    all: z
      .array(z.string())
      .optional()
      .describe('Style guidelines applied to all types of responses'),
    chat: z
      .array(z.string())
      .optional()
      .describe('Style guidelines specific to chat/conversation responses'),
    post: z
      .array(z.string())
      .optional()
      .describe('Style guidelines specific to social media posts'),
  })
  .optional()
  .describe(
    'Style configuration defining how the character communicates across different contexts'
  );

// Settings schema - flexible object allowing any JSON-serializable values
export const settingsSchema = z
  .record(
    z.string(),
    z.union([z.string(), z.boolean(), z.number(), z.object({}).loose(), z.array(z.any())])
  )
  .optional()
  .describe('Character-specific settings like avatar URL, preferences, and configuration');

// Secrets schema
export const secretsSchema = z
  .record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
  .optional()
  .describe('Secret values and API keys (should not be committed to version control)');

// Main Character schema
export const characterSchema = z
  .object({
    id: uuidSchema.optional().describe('Unique identifier for the character'),
    name: z
      .string()
      .min(1, 'Character name is required')
      .describe('The name of the character (e.g., "Eliza")'),
    username: z.string().optional().describe('Username for the character on various platforms'),
    system: z
      .string()
      .optional()
      .describe("System prompt that defines the character's core behavior and response style"),
    templates: z
      .record(z.string(), templateTypeSchema)
      .optional()
      .describe('Custom templates for generating different types of content'),
    bio: z
      .union([z.string(), z.array(z.string())])
      .describe('Character biography - can be a single string or array of biographical points'),
    messageExamples: z
      .array(z.array(messageExampleSchema))
      .optional()
      .describe('Example conversations showing how the character responds in different scenarios'),
    postExamples: z
      .array(z.string())
      .optional()
      .describe("Example social media posts demonstrating the character's voice and topics"),
    topics: z
      .array(z.string())
      .optional()
      .describe('Topics the character is knowledgeable about and engages with'),
    adjectives: z
      .array(z.string())
      .optional()
      .describe("Adjectives that describe the character's personality and traits"),
    knowledge: z
      .array(knowledgeItemSchema)
      .optional()
      .describe('Knowledge sources (files, directories) the character can reference'),
    plugins: z
      .array(z.string())
      .optional()
      .describe(
        'List of plugin package names to load (e.g., ["@elizaos/plugin-sql", "@elizaos/plugin-bootstrap"] - these are commonly required)'
      ),
    settings: settingsSchema,
    secrets: secretsSchema,
    style: styleSchema,
  })
  .strict() // Only allow known properties
  .describe('Complete character definition including personality, behavior, and capabilities');

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
