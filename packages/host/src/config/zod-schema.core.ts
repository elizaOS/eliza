/**
 * Zod schemas for model definition config fragments (API kind, compatibility
 * flags, model entry). The host config schema composes these; core owns them
 * so every host validates model entries identically.
 */
import z from "zod";

export const ModelApiSchema = z.union([
  z.literal("openai-completions"),
  z.literal("openai-responses"),
  z.literal("anthropic-messages"),
  z.literal("google-generative-ai"),
  z.literal("bedrock-converse-stream"),
]);

export const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
  })
  .strict()
  .optional();

export const ModelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    api: ModelApiSchema.optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
    cost: z
      .object({
        input: z.number().nonnegative().optional(),
        output: z.number().nonnegative().optional(),
        cacheRead: z.number().nonnegative().optional(),
        cacheWrite: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    compat: ModelCompatSchema,
  })
  .strict();

/** Explicit name for dependency-light config input validation. */
export const ModelDefinitionInputSchema = ModelDefinitionSchema;
