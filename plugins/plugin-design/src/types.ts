/** Defines and validates the provider-neutral design domain contracts. */

import * as z from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const opaqueText = (max: number) => z.string().min(1).max(max);

/** Provider artifact and deep-link URLs must be absolute HTTPS with no userinfo. */
export const httpsUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // error-policy:J3 An unparseable provider URL is an explicit invalid
      // result for the refinement, never a fake-valid default.
      return false;
    }
    return url.protocol === "https:" && !url.username && !url.password;
  }, "must be an absolute HTTPS URL without userinfo");

export const providerIdSchema = boundedText(64).regex(/^[a-z0-9][a-z0-9_-]*$/i);

export const designRefSchema = z
  .object({
    provider: providerIdSchema,
    providerDesignId: opaqueText(512),
    name: boundedText(300),
    deepLinkUrl: httpsUrlSchema,
    thumbnailUrl: httpsUrlSchema.optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const designPageSchema = z
  .object({
    designs: z.array(designRefSchema).max(100),
    nextCursor: opaqueText(2_048).nullable(),
  })
  .strict();

export const designSearchRequestSchema = z
  .object({
    query: boundedText(500),
    cursor: opaqueText(2_048).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const designExportFormatSchema = z.enum(["png", "jpg", "svg", "pdf"]);

export const designExportRequestSchema = z
  .object({
    providerDesignId: opaqueText(512),
    format: designExportFormatSchema,
    /** Provider-specific node/page selector (for example a Figma node id). */
    nodeId: opaqueText(256).optional(),
    scale: z.number().finite().min(0.01).max(4).optional(),
  })
  .strict();

export const designExportArtifactSchema = z
  .object({
    provider: providerIdSchema,
    providerDesignId: opaqueText(512),
    format: designExportFormatSchema,
    /** Short-lived provider download URLs; bytes are never rehosted here. */
    urls: z.array(httpsUrlSchema).min(1).max(20),
  })
  .strict();

export const designCommentSchema = z
  .object({
    provider: providerIdSchema,
    commentId: opaqueText(512),
    message: z.string().max(10_000),
    author: boundedText(300),
    createdAt: z.string().datetime({ offset: true }),
    resolved: z.boolean(),
  })
  .strict();

export const designCommentPageSchema = z
  .object({
    comments: z.array(designCommentSchema).max(200),
    nextCursor: opaqueText(2_048).nullable(),
  })
  .strict();

export type DesignRef = z.infer<typeof designRefSchema>;
export type DesignPage = z.infer<typeof designPageSchema>;
export type DesignExportFormat = z.infer<typeof designExportFormatSchema>;
export type DesignExportArtifact = z.infer<typeof designExportArtifactSchema>;
export type DesignComment = z.infer<typeof designCommentSchema>;
export type DesignCommentPage = z.infer<typeof designCommentPageSchema>;

export interface DesignSearchRequest {
  query: string;
  cursor?: string;
  limit?: number;
}

export interface DesignExportRequest {
  providerDesignId: string;
  format: DesignExportFormat;
  nodeId?: string;
  scale?: number;
}

export type DesignCapability = "search" | "get" | "export" | "comments";
