import z from "zod";

export const CloudCodingAgentSchema = z.enum(["claude", "codex", "opencode"]);

export const CloudCodingContainerStatusSchema = z.enum([
  "requested",
  "pending",
  "building",
  "running",
  "failed",
  "stopped",
]);

export const CloudVfsSourceKindSchema = z.enum(["project", "workspace"]);
export const CloudVfsFileEncodingSchema = z.enum(["utf-8", "base64"]);
export const CloudCodingSyncDirectionSchema = z.enum([
  "pull",
  "push",
  "roundtrip",
]);
export const CloudCodingPatchFormatSchema = z.enum([
  "unified-diff",
  "json-patch",
]);
export const CloudContainerArchitectureSchema = z.enum(["arm64", "x86_64"]);

export const CloudVfsFileSchema = z
  .object({
    path: z.string().regex(/\S/, "path is required"),
    contents: z.string().optional(),
    encoding: CloudVfsFileEncodingSchema.optional(),
    size: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
    mode: z.string().optional(),
    mtimeMs: z.number().optional(),
  })
  .strict()
  .transform((value) => ({ ...value, path: value.path.trim() }));

export const CloudVfsDeletedFileSchema = z
  .object({
    path: z.string().regex(/\S/, "path is required"),
    sha256: z.string().optional(),
  })
  .strict()
  .transform((value) => ({ ...value, path: value.path.trim() }));

export const CloudVfsBundleSchema = z
  .object({
    sourceKind: CloudVfsSourceKindSchema,
    projectId: z.string().regex(/\S/).optional(),
    workspaceId: z.string().regex(/\S/).optional(),
    rootPath: z.string().regex(/\S/).optional(),
    snapshotId: z.string().regex(/\S/).optional(),
    revision: z.string().regex(/\S/).optional(),
    files: z.array(CloudVfsFileSchema).optional(),
    deletedFiles: z.array(CloudVfsDeletedFileSchema).optional(),
    manifest: z
      .object({
        fileCount: z.number().int().nonnegative().optional(),
        totalBytes: z.number().int().nonnegative().optional(),
        ignoredPaths: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const PromoteVfsToCloudContainerRequestSchema = z
  .object({
    source: CloudVfsBundleSchema,
    name: z.string().optional(),
    description: z.string().optional(),
    preferredAgent: CloudCodingAgentSchema.optional(),
    target: z
      .object({
        containerId: z.string().regex(/\S/).optional(),
        workspacePath: z.string().regex(/\S/).optional(),
        branchName: z.string().regex(/\S/).optional(),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const RequestCodingAgentContainerRequestSchema = z
  .object({
    agent: CloudCodingAgentSchema,
    promotionId: z.string().regex(/\S/).optional(),
    source: CloudVfsBundleSchema.optional(),
    prompt: z.string().optional(),
    container: z
      .object({
        name: z.string().optional(),
        image: z.string().optional(),
        cpu: z.number().optional(),
        memory: z.number().optional(),
        architecture: CloudContainerArchitectureSchema.optional(),
        environmentVars: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    workspacePath: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CloudCodingPatchSchema = z
  .object({
    path: z.string().regex(/\S/, "path is required"),
    format: CloudCodingPatchFormatSchema,
    patch: z.string(),
    baseSha256: z.string().optional(),
    afterSha256: z.string().optional(),
  })
  .strict()
  .transform((value) => ({ ...value, path: value.path.trim() }));

export const SyncCloudCodingContainerRequestSchema = z
  .object({
    direction: CloudCodingSyncDirectionSchema.optional(),
    target: z
      .object({
        sourceKind: CloudVfsSourceKindSchema,
        projectId: z.string().regex(/\S/).optional(),
        workspaceId: z.string().regex(/\S/).optional(),
        baseRevision: z.string().regex(/\S/).optional(),
        targetRevision: z.string().regex(/\S/).optional(),
      })
      .strict(),
    changedFiles: z.array(CloudVfsFileSchema).optional(),
    deletedFiles: z.array(CloudVfsDeletedFileSchema).optional(),
    patches: z.array(CloudCodingPatchSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CloudCodingAgent = z.infer<typeof CloudCodingAgentSchema>;
export type CloudCodingContainerStatus = z.infer<
  typeof CloudCodingContainerStatusSchema
>;
export type CloudVfsSourceKind = z.infer<typeof CloudVfsSourceKindSchema>;
export type CloudVfsFileEncoding = z.infer<typeof CloudVfsFileEncodingSchema>;
export type CloudVfsFile = z.infer<typeof CloudVfsFileSchema>;
export type CloudVfsDeletedFile = z.infer<typeof CloudVfsDeletedFileSchema>;
export type CloudVfsBundle = z.infer<typeof CloudVfsBundleSchema>;
export type CloudContainerArchitecture = z.infer<
  typeof CloudContainerArchitectureSchema
>;
export type PromoteVfsToCloudContainerRequest = z.infer<
  typeof PromoteVfsToCloudContainerRequestSchema
>;
export type RequestCodingAgentContainerRequest = z.infer<
  typeof RequestCodingAgentContainerRequestSchema
>;
export type CloudCodingSyncDirection = z.infer<
  typeof CloudCodingSyncDirectionSchema
>;
export type CloudCodingPatchFormat = z.infer<
  typeof CloudCodingPatchFormatSchema
>;
export type CloudCodingPatch = z.infer<typeof CloudCodingPatchSchema>;
export type SyncCloudCodingContainerRequest = z.infer<
  typeof SyncCloudCodingContainerRequestSchema
>;

export interface CloudCodingPromotion {
  promotionId: string;
  status: "accepted" | "uploaded";
  source: CloudVfsBundle;
  workspacePath: string;
  uploadUrl?: string;
  expiresAt?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PromoteVfsToCloudContainerResponse {
  success: boolean;
  data: CloudCodingPromotion;
  message?: string;
}

export interface CloudCodingContainerSession {
  containerId: string;
  status: CloudCodingContainerStatus;
  agent: CloudCodingAgent;
  promotionId?: string;
  workspacePath: string;
  url?: string | null;
  branchName?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface RequestCodingAgentContainerResponse {
  success: boolean;
  data: CloudCodingContainerSession;
  message?: string;
}

export interface CloudCodingSyncResult {
  syncId: string;
  containerId: string;
  status: "accepted" | "applied" | "ready";
  direction: CloudCodingSyncDirection;
  target: SyncCloudCodingContainerRequest["target"];
  changedFiles: CloudVfsFile[];
  deletedFiles: CloudVfsDeletedFile[];
  patches: CloudCodingPatch[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SyncCloudCodingContainerResponse {
  success: boolean;
  data: CloudCodingSyncResult;
  message?: string;
}
