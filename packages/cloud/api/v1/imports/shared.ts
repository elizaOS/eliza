// Shared helpers for the /api/v1/imports route tree: typed failure DTO responses and common schemas.
import type { Context } from "hono";
import { z } from "zod";
import {
  type ConversationImportFailureDto,
  importFailureHttpStatus,
} from "@/types/conversation-imports";

/**
 * Canonical failure response for the conversation-import DTO union: the stable
 * `code` plus every code-specific field under `details`, at the status the
 * shared mapping dictates. Routes never invent statuses or recompute fields.
 */
export function importFailureResponse(
  c: Context,
  failure: ConversationImportFailureDto,
): Response {
  const { ok: _ok, code, message, ...details } = failure;
  return c.json(
    { success: false, error: message, code, details },
    importFailureHttpStatus(code),
  );
}

export const sessionIdSchema = z.string().uuid();
export const batchIdSchema = z.string().uuid();

export const usageEstimateSchema = z.object({
  uploadBytes: z.number().int().positive(),
  conversationCount: z.number().int().nonnegative().optional(),
  storageBytes: z.number().int().nonnegative().optional(),
  embeddingUnits: z.number().int().nonnegative().optional(),
});

export const initUploadSchema = usageEstimateSchema.extend({
  source: z.string().trim().min(1).max(64),
  filename: z.string().trim().min(1).max(256),
  contentType: z.string().trim().min(1).max(128),
  chunkSize: z.number().int().positive(),
  declaredSha256: z
    .string()
    .trim()
    .regex(/^[A-Fa-f0-9]{64}$/, "must be a hex sha256 digest"),
  appId: z.string().trim().min(1).max(128).optional(),
  retainRawUpload: z.boolean().optional(),
  retainReason: z.string().trim().min(1).max(500).optional(),
});
