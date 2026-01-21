/**
 * Validation schemas for moderation features
 * Block, Mute, and Report functionality
 */

import { z } from "zod";

// ============ Block Schemas ============

export const BlockUserSchema = z.object({
  action: z.enum(["block", "unblock"]),
  reason: z.string().max(500).optional(),
});

export const GetBlocksSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

// ============ Mute Schemas ============

export const MuteUserSchema = z.object({
  action: z.enum(["mute", "unmute"]),
  reason: z.string().max(500).optional(),
});

export const GetMutesSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

// ============ Report Schemas ============

export const ReportCategoryEnum = z.enum([
  "spam",
  "harassment",
  "hate_speech",
  "violence",
  "misinformation",
  "inappropriate",
  "impersonation",
  "self_harm",
  "other",
]);

export const ReportTypeEnum = z.enum(["user", "post"]);

export const ReportStatusEnum = z.enum([
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
]);

export const ReportPriorityEnum = z.enum(["low", "normal", "high", "critical"]);

export const CreateReportSchema = z
  .object({
    reportType: ReportTypeEnum,
    reportedUserId: z.string().optional(),
    reportedPostId: z.string().optional(),
    category: ReportCategoryEnum,
    reason: z.string().min(10).max(2000),
    evidence: z.string().url().optional(),
  })
  .refine(
    (data) => {
      // Must have either reportedUserId or reportedPostId
      return !!(data.reportedUserId || data.reportedPostId);
    },
    {
      message: "Either reportedUserId or reportedPostId must be provided",
    },
  );

export const UpdateReportSchema = z.object({
  status: ReportStatusEnum.optional(),
  priority: ReportPriorityEnum.optional(),
  resolution: z.string().max(1000).optional(),
});

export const GetReportsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  status: ReportStatusEnum.optional(),
  category: ReportCategoryEnum.optional(),
  priority: ReportPriorityEnum.optional(),
  reportType: ReportTypeEnum.optional(),
  reporterId: z.string().optional(),
  reportedUserId: z.string().optional(),
  reportedPostId: z.string().optional(),
  sortBy: z.enum(["created", "updated", "priority"]).default("created"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ============ Admin Report Schemas ============

export const AdminReportActionSchema = z
  .object({
    action: z.enum(["resolve", "dismiss", "escalate", "ban_user", "evaluate"]),
    resolution: z.string().min(1).max(1000).optional(),
  })
  .refine(
    (data) => {
      // Resolution required for all actions except 'evaluate'
      if (data.action !== "evaluate" && !data.resolution) {
        return false;
      }
      return true;
    },
    {
      message: "Resolution is required for this action",
    },
  );

export const GetAdminReportsStatsSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

// ============ Type exports ============

export type BlockUserInput = z.infer<typeof BlockUserSchema>;
export type MuteUserInput = z.infer<typeof MuteUserSchema>;
export type CreateReportInput = z.infer<typeof CreateReportSchema>;
export type UpdateReportInput = z.infer<typeof UpdateReportSchema>;
export type GetReportsInput = z.infer<typeof GetReportsSchema>;
export type AdminReportActionInput = z.infer<typeof AdminReportActionSchema>;
export type ReportCategory = z.infer<typeof ReportCategoryEnum>;
export type ReportType = z.infer<typeof ReportTypeEnum>;
export type ReportStatus = z.infer<typeof ReportStatusEnum>;
export type ReportPriority = z.infer<typeof ReportPriorityEnum>;
