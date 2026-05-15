/**
 * Zod schemas for Ollama plugin configuration.
 *
 * `VisionOllamaConfigSchema` was previously declared in both
 * packages/shared/src/config/zod-schema.core.ts (canonical) and
 * packages/agent/src/config/zod-schema.core.ts (duplicate). Phase 4B
 * removes the duplicate from agent and lets this plugin own the schema
 * alongside its provider. The agent's vision config schema now imports
 * it from here.
 */

import { z } from "zod";

export const VisionOllamaConfigSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    autoDownload: z.boolean().optional(),
  })
  .strict()
  .optional();
