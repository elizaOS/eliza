/** Validates provider answers and persisted vision evidence at their input boundaries. */
import { z } from "zod";

export const visionAnswerSchema = z.strictObject({
  id: z.string().min(1),
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  details: z.string(),
});

export const askResultSchema = z.object({
  answers: z.array(visionAnswerSchema),
  provenance: z.object({
    backend: z.enum(["anthropic", "openai", "local", "cli"]),
    model: z.string().min(1),
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
    latencyMs: z.number().nonnegative(),
    retries: z.number().int().nonnegative(),
    timestamp: z.iso.datetime(),
    cached: z.boolean(),
    dimensions: z.object({
      originalWidth: z.number().int().positive(),
      originalHeight: z.number().int().positive(),
      sentWidth: z.number().int().positive(),
      sentHeight: z.number().int().positive(),
    }),
  }),
});
