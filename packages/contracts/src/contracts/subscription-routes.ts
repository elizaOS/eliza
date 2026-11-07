/**
 * Zod schemas for the subscription (Anthropic / OpenAI Codex) login
 * routes.
 *
 * Routes covered:
 *   POST /api/subscription/anthropic/exchange     { code }
 *   POST /api/subscription/anthropic/setup-token  { token: 'sk-ant-...' }
 *   POST /api/subscription/openai/exchange        { code?, waitForCallback? }
 *
 * The /start endpoints don't read a body. DELETE /api/subscription/:provider
 * has no body either (provider is in the path).
 */

import z from "zod";

export const PostSubscriptionAnthropicExchangeRequestSchema = z
  .object({
    code: z.string().regex(/\S/, "Missing code"),
  })
  .strict()
  .transform((value) => ({ code: value.code.trim() }));

export const PostSubscriptionAnthropicSetupTokenRequestSchema = z
  .object({
    token: z.string().regex(/\S/, "token is required"),
  })
  .strict()
  .transform((value) => ({ token: value.token.trim() }))
  .refine((value) => value.token.startsWith("sk-ant-"), {
    message: "Invalid token format — expected sk-ant-oat01-...",
  });

/**
 * OpenAI Codex exchange — caller must provide `code` OR set
 * `waitForCallback: true`. The handler still rejects the
 * neither-supplied case explicitly with a tailored message; the
 * schema only enforces type correctness on each field.
 */
export const PostSubscriptionOpenAIExchangeRequestSchema = z
  .object({
    code: z.string().optional(),
    waitForCallback: z.boolean().optional(),
  })
  .strict()
  .transform((value) => {
    const code = value.code?.trim();
    return {
      ...(code ? { code } : {}),
      ...(value.waitForCallback !== undefined
        ? { waitForCallback: value.waitForCallback }
        : {}),
    };
  });

export type PostSubscriptionAnthropicExchangeRequest = z.infer<
  typeof PostSubscriptionAnthropicExchangeRequestSchema
>;
export type PostSubscriptionAnthropicSetupTokenRequest = z.infer<
  typeof PostSubscriptionAnthropicSetupTokenRequestSchema
>;
export type PostSubscriptionOpenAIExchangeRequest = z.infer<
  typeof PostSubscriptionOpenAIExchangeRequestSchema
>;
