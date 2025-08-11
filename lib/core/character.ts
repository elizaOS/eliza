import { z } from "zod";

// Supporting type schemas
const uuidSchema = z.uuidv4();

const templateTypeSchema = z.string();

const messageExampleSchema = z.object({
  user: z.string(),
  content: z.object({
    text: z.string(),
  }),
});

const directoryItemSchema: z.ZodType<DirectoryItem> = z.object({
  name: z.string(),
  type: z.enum(["file", "directory"]),
  path: z.string(),
  children: z.array(z.lazy(() => directoryItemSchema)).optional(),
});

// Define DirectoryItem type for circular reference
export interface DirectoryItem {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: DirectoryItem[];
}

// Knowledge base item schema - use discriminated union for better parsing
const knowledgeItemSchema = z.union([
  z.string(),
  directoryItemSchema,
  z
    .object({
      path: z.string(),
      shared: z.boolean().optional(),
    })
    .refine((obj) => !("name" in obj) && !("type" in obj), {
      message:
        "Path-only knowledge items should not have 'name' or 'type' properties",
    }),
]);

// Settings value schema
const settingsValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.number(),
  z.record(z.string(), z.any()),
]);

// Secrets value schema
const secretsValueSchema = z.union([z.string(), z.boolean(), z.number()]);

// Main Character schema
export const characterSchema = z.object({
  /** Optional unique identifier */
  id: uuidSchema.optional(),

  /** Character name */
  name: z.string(),

  /** Optional username */
  username: z.string().optional(),

  /** Optional system prompt */
  system: z.string().optional(),

  /** Optional prompt templates */
  templates: z.record(z.string(), templateTypeSchema).optional(),

  /** Character bio */
  bio: z.union([z.string(), z.array(z.string())]),

  /** Example messages */
  messageExamples: z.array(z.array(messageExampleSchema)).optional(),

  /** Example posts */
  postExamples: z.array(z.string()).optional(),

  /** Known topics */
  topics: z.array(z.string()).optional(),

  /** Character traits */
  adjectives: z.array(z.string()).optional(),

  /** Optional knowledge base */
  knowledge: z.array(knowledgeItemSchema).optional(),

  /** Available plugins */
  plugins: z.array(z.string()).optional(),

  /** Optional configuration */
  settings: z.record(z.string(), settingsValueSchema).optional(),

  /** Optional secrets */
  secrets: z.record(z.string(), secretsValueSchema).optional(),

  /** Writing style guides */
  style: z
    .object({
      all: z.array(z.string()).optional(),
      chat: z.array(z.string()).optional(),
      post: z.array(z.string()).optional(),
    })
    .optional(),
});

// Export TypeScript type using z.infer for DRY
export type Character = z.infer<typeof characterSchema>;

// Export supporting types
export type UUID = z.infer<typeof uuidSchema>;
export type TemplateType = z.infer<typeof templateTypeSchema>;
export type MessageExample = z.infer<typeof messageExampleSchema>;
