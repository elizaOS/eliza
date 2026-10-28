/**
 * Zod schemas for the agent-lifecycle and agent-transfer write
 * routes. agent-admin (restart / reset) takes no body and is
 * not covered here.
 *
 * Routes covered:
 *   POST /api/agent/autonomy       { enabled: boolean }
 *   POST /api/agent/export         { password, includeLogs? }
 *
 * `POST /api/agent/import` reads a binary multipart-style body via
 * `readRequestBodyBuffer` (not `readJsonBody`) so it's not migrated.
 */

import z from "zod";

export const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 12;
export const AGENT_TRANSFER_MAX_PASSWORD_BYTES = 1024;

export function agentTransferPasswordByteLength(password: string): number {
  return new TextEncoder().encode(password).byteLength;
}

export const AgentTransferPasswordSchema = z
  .string()
  .min(
    AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
    `A password of at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters is required.`,
  )
  .refine(
    (password) =>
      agentTransferPasswordByteLength(password) <=
      AGENT_TRANSFER_MAX_PASSWORD_BYTES,
    {
      message: `Password must be at most ${AGENT_TRANSFER_MAX_PASSWORD_BYTES} bytes when UTF-8 encoded.`,
    },
  );

export const PostAgentAutonomyRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const PostAgentExportRequestSchema = z
  .object({
    password: AgentTransferPasswordSchema,
    includeLogs: z.boolean().optional(),
    excludeSecrets: z.boolean().optional(),
  })
  .strict();

export type PostAgentAutonomyRequest = z.infer<
  typeof PostAgentAutonomyRequestSchema
>;
export type PostAgentExportRequest = z.infer<
  typeof PostAgentExportRequestSchema
>;
