/** Request schemas for bug reports and release-channel selection. */

import z from "zod";

// ---------------------------------------------------------------------------
// bug-report
// ---------------------------------------------------------------------------

const BugReportCategorySchema = z.enum(["general", "startup-failure"]);

const BugReportStartupSchema = z
  .object({
    reason: z.string().optional(),
    phase: z.string().optional(),
    message: z.string().optional(),
    detail: z.string().optional(),
    status: z.number().optional(),
    path: z.string().optional(),
  })
  .strict();

export const PostBugReportRequestSchema = z
  .object({
    description: z.string().regex(/\S/, "description is required"),
    stepsToReproduce: z.string().regex(/\S/, "stepsToReproduce is required"),
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string().optional(),
    environment: z.string().optional(),
    nodeVersion: z.string().optional(),
    modelProvider: z.string().optional(),
    logs: z.string().optional(),
    category: BugReportCategorySchema.optional(),
    appVersion: z.string().optional(),
    releaseChannel: z.string().optional(),
    startup: BugReportStartupSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// update channel
// ---------------------------------------------------------------------------

const UpdateChannelSchema = z.enum(["stable", "beta", "nightly"]);

export const PutUpdateChannelRequestSchema = z
  .object({
    channel: UpdateChannelSchema,
  })
  .strict();

export type PostBugReportRequest = z.infer<typeof PostBugReportRequestSchema>;
export type PutUpdateChannelRequest = z.infer<
  typeof PutUpdateChannelRequestSchema
>;
export type BugReportCategory = z.infer<typeof BugReportCategorySchema>;
export type BugReportStartup = z.infer<typeof BugReportStartupSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;
