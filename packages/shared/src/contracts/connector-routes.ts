/**
 * Zod schemas for connector + provider-switch HTTP routes.
 *
 * connector-account-routes.ts already validates body inputs through
 * its own (file-local) zod schemas; those stay in place and aren't
 * re-exported here.
 *
 * Routes covered:
 *   POST /api/connectors           { name: string, config: object }
 *   POST /api/provider/switch
 *     { provider: string, apiKey?, primaryModel?, useLocalEmbeddings? }
 */

import z from "zod";

/**
 * Reserved object keys we never want to allow as connector names —
 * the server clones config objects defensively, so a `__proto__`
 * connector name would silently no-op or pollute the object's
 * prototype chain. The wire-level schema rejects upfront.
 */
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const PostConnectorRequestSchema = z
  .object({
    name: z.string().regex(/\S/, "Missing connector name"),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
  .transform((value) => ({
    name: value.name.trim(),
    config: value.config,
  }))
  .refine((value) => !RESERVED_OBJECT_KEYS.has(value.name), {
    message:
      'Invalid connector name: "__proto__", "constructor", and "prototype" are reserved',
  });

export const PostProviderSwitchRequestSchema = z
  .object({
    provider: z.string().regex(/\S/, "Missing provider"),
    apiKey: z.string().max(512, "API key is too long").optional(),
    primaryModel: z.string().optional(),
    useLocalEmbeddings: z.boolean().optional(),
  })
  .strict()
  .transform((value) => {
    const apiKey = value.apiKey?.trim();
    const primaryModel = value.primaryModel?.trim();
    return {
      provider: value.provider.trim(),
      ...(apiKey ? { apiKey } : {}),
      ...(primaryModel ? { primaryModel } : {}),
      ...(value.useLocalEmbeddings !== undefined
        ? { useLocalEmbeddings: value.useLocalEmbeddings }
        : {}),
    };
  });

export type PostConnectorRequest = z.infer<typeof PostConnectorRequestSchema>;
export type PostProviderSwitchRequest = z.infer<
  typeof PostProviderSwitchRequestSchema
>;
