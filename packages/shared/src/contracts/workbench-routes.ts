/**
 * Zod schemas for the workbench todos HTTP write surface.
 *
 * Routes covered:
 *   POST /api/workbench/todos              (create)
 *   POST /api/workbench/todos/:id/complete
 *   PUT  /api/workbench/todos/:id          (update)
 *
 * GET and DELETE variants take no body.
 */

import z from "zod";
import { CloudCodingAgentSchema } from "./cloud-coding-containers.js";

const WorkbenchTodoPrioritySchema = z.union([z.number(), z.string(), z.null()]);

const WorkbenchTodoBaseShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  priority: WorkbenchTodoPrioritySchema.optional(),
  isUrgent: z.boolean().optional(),
  type: z.string().optional(),
  isCompleted: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
};

export const PostWorkbenchTodoRequestSchema = z
  .object({
    ...WorkbenchTodoBaseShape,
    name: z.string().regex(/\S/, "name is required"),
  })
  .strict()
  .transform((value) => ({
    ...value,
    name: value.name.trim(),
  }));

export const PostWorkbenchTodoCompleteRequestSchema = z
  .object({
    isCompleted: z.boolean().optional(),
  })
  .strict();

export const PutWorkbenchTodoRequestSchema = z
  .object(WorkbenchTodoBaseShape)
  .strict();

export type PostWorkbenchTodoRequest = z.infer<
  typeof PostWorkbenchTodoRequestSchema
>;
export type PostWorkbenchTodoCompleteRequest = z.infer<
  typeof PostWorkbenchTodoCompleteRequestSchema
>;
export type PutWorkbenchTodoRequest = z.infer<
  typeof PutWorkbenchTodoRequestSchema
>;
export type WorkbenchTodoPriority = z.infer<typeof WorkbenchTodoPrioritySchema>;

export const PostWorkbenchVfsProjectRequestSchema = z
  .object({
    projectId: z.string().regex(/\S/, "projectId is required"),
  })
  .strict()
  .transform((value) => ({
    projectId: value.projectId.trim(),
  }));

export const PutWorkbenchVfsFileRequestSchema = z
  .object({
    path: z.string().regex(/\S/, "path is required"),
    content: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    path: value.path.trim(),
  }));

export const PostWorkbenchVfsSnapshotRequestSchema = z
  .object({
    note: z.string().optional(),
  })
  .strict();

export const PostWorkbenchVfsRollbackRequestSchema = z
  .object({
    snapshotId: z.string().regex(/\S/, "snapshotId is required"),
  })
  .strict()
  .transform((value) => ({
    snapshotId: value.snapshotId.trim(),
  }));

export const PostWorkbenchVfsCompilePluginRequestSchema = z
  .object({
    entry: z.string().regex(/\S/, "entry is required"),
    outFile: z.string().regex(/\S/).optional(),
    format: z.enum(["esm", "cjs"]).optional(),
    target: z.string().regex(/\S/).optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    entry: value.entry.trim(),
    ...(value.outFile ? { outFile: value.outFile.trim() } : {}),
    ...(value.target ? { target: value.target.trim() } : {}),
  }));

export const PostWorkbenchVfsLoadPluginRequestSchema = z
  .object({
    entry: z.string().regex(/\S/, "entry is required"),
    outFile: z.string().regex(/\S/).optional(),
    compileFirst: z.boolean().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    entry: value.entry.trim(),
    ...(value.outFile ? { outFile: value.outFile.trim() } : {}),
  }));

export const PostWorkbenchVfsPromoteToCloudRequestSchema = z
  .object({
    snapshotId: z.string().regex(/\S/).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    preferredAgent: CloudCodingAgentSchema.optional(),
    workspacePath: z.string().regex(/\S/).optional(),
    branchName: z.string().regex(/\S/).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    ...(value.snapshotId ? { snapshotId: value.snapshotId.trim() } : {}),
    ...(value.workspacePath
      ? { workspacePath: value.workspacePath.trim() }
      : {}),
    ...(value.branchName ? { branchName: value.branchName.trim() } : {}),
  }));

export type PostWorkbenchVfsProjectRequest = z.infer<
  typeof PostWorkbenchVfsProjectRequestSchema
>;
export type PutWorkbenchVfsFileRequest = z.infer<
  typeof PutWorkbenchVfsFileRequestSchema
>;
export type PostWorkbenchVfsSnapshotRequest = z.infer<
  typeof PostWorkbenchVfsSnapshotRequestSchema
>;
export type PostWorkbenchVfsRollbackRequest = z.infer<
  typeof PostWorkbenchVfsRollbackRequestSchema
>;
export type PostWorkbenchVfsCompilePluginRequest = z.infer<
  typeof PostWorkbenchVfsCompilePluginRequestSchema
>;
export type PostWorkbenchVfsLoadPluginRequest = z.infer<
  typeof PostWorkbenchVfsLoadPluginRequestSchema
>;
export type PostWorkbenchVfsPromoteToCloudRequest = z.infer<
  typeof PostWorkbenchVfsPromoteToCloudRequestSchema
>;
