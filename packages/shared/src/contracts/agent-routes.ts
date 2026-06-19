/**
 * Zod schemas for the agent-lifecycle, agent-transfer, and registry
 * write routes. agent-admin (restart / reset) takes no body and is
 * not covered here.
 *
 * Routes covered:
 *   POST /api/agent/autonomy       { enabled: boolean }
 *   POST /api/agent/export         { password, includeLogs? }
 *   POST /api/registry/register    { name?, endpoint?, tokenURI? }
 *   POST /api/registry/update-uri  { tokenURI }
 *   POST /api/registry/sync        { name?, endpoint?, tokenURI? }
 *
 * `POST /api/agent/import` reads a binary multipart-style body via
 * `readRequestBodyBuffer` (not `readJsonBody`) so it's not migrated.
 */

import z from "zod";

export const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;

export const PostAgentAutonomyRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const PostAgentExportRequestSchema = z
  .object({
    password: z
      .string()
      .min(
        AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
        `A password of at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters is required.`,
      ),
    includeLogs: z.boolean().optional(),
  })
  .strict();

export const PostRegistryRegisterRequestSchema = z
  .object({
    name: z.string().optional(),
    endpoint: z.string().optional(),
    tokenURI: z.string().optional(),
  })
  .strict()
  .transform((value) => {
    const name = value.name?.trim();
    const endpoint = value.endpoint?.trim();
    const tokenURI = value.tokenURI?.trim();
    return {
      ...(name ? { name } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(tokenURI ? { tokenURI } : {}),
    };
  });

export const PostRegistryUpdateUriRequestSchema = z
  .object({
    tokenURI: z.string().regex(/\S/, "tokenURI is required"),
  })
  .strict()
  .transform((value) => ({ tokenURI: value.tokenURI.trim() }));

export const PostRegistrySyncRequestSchema = PostRegistryRegisterRequestSchema;

export type PostAgentAutonomyRequest = z.infer<
  typeof PostAgentAutonomyRequestSchema
>;
export type PostAgentExportRequest = z.infer<
  typeof PostAgentExportRequestSchema
>;
export type PostRegistryRegisterRequest = z.infer<
  typeof PostRegistryRegisterRequestSchema
>;
export type PostRegistryUpdateUriRequest = z.infer<
  typeof PostRegistryUpdateUriRequestSchema
>;
export type PostRegistrySyncRequest = z.infer<
  typeof PostRegistrySyncRequestSchema
>;
