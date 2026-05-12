/**
 * Zod schemas for the character HTTP write surface.
 *
 * `PUT /api/character` already uses the existing `validateCharacter`
 * zod helper (which mirrors the full character schema). Only the
 * generate endpoint is migrated here.
 *
 * The OpenAI-compat (`POST /v1/chat/completions`) and Anthropic-compat
 * (`POST /v1/messages`) endpoints are intentionally NOT migrated —
 * they are external-API surface that must mirror upstream specs and
 * accept partial / future fields without rejecting.
 *
 * Routes covered:
 *   POST /api/character/generate  { field, context, mode? }
 */

import z from "zod";

const CharacterGenerateFieldSchema = z.enum([
  "bio",
  "system",
  "style",
  "chatExamples",
  "postExamples",
]);

const CharacterGenerateModeSchema = z.enum(["append", "replace"]);

const CharacterGenerateContextSchema = z
  .object({
    name: z.string().optional(),
    system: z.string().optional(),
    bio: z.string().optional(),
    topics: z.array(z.string()).optional(),
    style: z
      .object({
        all: z.array(z.string()).optional(),
        chat: z.array(z.string()).optional(),
        post: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    postExamples: z.array(z.string()).optional(),
  })
  .strict();

export const PostCharacterGenerateRequestSchema = z
  .object({
    field: CharacterGenerateFieldSchema,
    context: CharacterGenerateContextSchema,
    mode: CharacterGenerateModeSchema.optional(),
  })
  .strict();

export type PostCharacterGenerateRequest = z.infer<
  typeof PostCharacterGenerateRequestSchema
>;
export type CharacterGenerateField = z.infer<
  typeof CharacterGenerateFieldSchema
>;
export type CharacterGenerateMode = z.infer<typeof CharacterGenerateModeSchema>;
export type CharacterGenerateContext = z.infer<
  typeof CharacterGenerateContextSchema
>;
