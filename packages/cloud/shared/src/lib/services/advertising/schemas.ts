import { z } from "zod";

export const AdPlatformSchema = z.enum(["meta", "google", "tiktok", "linkedin"]);

export const CampaignObjectiveSchema = z.enum([
  "awareness",
  "traffic",
  "engagement",
  "leads",
  "app_promotion",
  "sales",
  "conversions",
]);

export const BudgetTypeSchema = z.enum(["daily", "lifetime"]);

export const CampaignBidStrategySchema = z.enum(["cpm", "cpc", "cpa"]);

export const CampaignOptimizationGoalSchema = z.enum(["reach", "clicks", "conversions"]);

export const CreativeTypeSchema = z.enum(["image", "video", "carousel"]);

export const CallToActionSchema = z.enum([
  "learn_more",
  "shop_now",
  "sign_up",
  "download",
  "contact_us",
  "get_offer",
  "book_now",
  "watch_more",
  "apply_now",
  "subscribe",
]);

export const MediaSourceSchema = z.enum(["generation", "upload"]);

export const MediaTypeSchema = z.enum(["image", "video"]);

const TargetingTextArraySchema = z
  .array(z.string().trim().min(1).max(120))
  .max(200)
  .transform((values) => Array.from(new Set(values)));

export const TargetingSchema = z
  .object({
    locations: TargetingTextArraySchema.optional(),
    ageMin: z.number().int().min(13).max(65).optional(),
    ageMax: z.number().int().min(13).max(65).optional(),
    genders: z
      .array(z.enum(["male", "female", "all"]))
      .max(3)
      .optional(),
    interests: TargetingTextArraySchema.optional(),
    behaviors: TargetingTextArraySchema.optional(),
    customAudiences: TargetingTextArraySchema.optional(),
    excludedAudiences: TargetingTextArraySchema.optional(),
    placements: TargetingTextArraySchema.optional(),
    languages: TargetingTextArraySchema.optional(),
  })
  .superRefine((targeting, ctx) => {
    if (
      targeting.ageMin !== undefined &&
      targeting.ageMax !== undefined &&
      targeting.ageMin > targeting.ageMax
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ageMin"],
        message: "ageMin must be less than or equal to ageMax",
      });
    }
    if (targeting.genders?.includes("all") && targeting.genders.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["genders"],
        message: "genders cannot combine all with specific genders",
      });
    }
  });

const TargetingOrSegmentSchema = z
  .object({
    targeting: TargetingSchema.optional(),
    audienceSegmentId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.targeting && value.audienceSegmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audienceSegmentId"],
        message: "Provide targeting or audienceSegmentId, not both",
      });
    }
  });

const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm in 24-hour local time");

// End times additionally allow "24:00" (exclusive end of day) so a window can
// cover a full local day — matches Meta's adset_schedule end_minute of 1440.
const LocalEndTimeSchema = z
  .string()
  .regex(
    /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/,
    "Use HH:mm in 24-hour local time (24:00 = end of day)",
  );

function localTimeToMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export const DaypartingWindowSchema = z
  .object({
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startTime: LocalTimeSchema,
    endTime: LocalEndTimeSchema,
  })
  .superRefine((window, ctx) => {
    if (new Set(window.daysOfWeek).size !== window.daysOfWeek.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daysOfWeek"],
        message: "daysOfWeek cannot contain duplicates",
      });
    }
    if (localTimeToMinute(window.startTime) >= localTimeToMinute(window.endTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "endTime must be after startTime within the same local day",
      });
    }
  });

export const DaypartingScheduleSchema = z
  .object({
    timezone: z.string().min(1),
    windows: z.array(DaypartingWindowSchema).min(1).max(64),
  })
  .superRefine((schedule, ctx) => {
    if (!isSupportedTimeZone(schedule.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: "Unsupported IANA timezone",
      });
    }
  });

export const CreativeMediaSchema = z.object({
  id: z.string().uuid(),
  source: MediaSourceSchema,
  url: z.string().url(),
  providerAssetId: z.string().min(1).optional(),
  thumbnailUrl: z.string().url().optional(),
  type: MediaTypeSchema,
  order: z.number().int().min(0),
});

export const ConnectAccountSchema = z.object({
  platform: AdPlatformSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  externalAccountId: z.string().optional(),
  accountName: z.string().optional(),
});

export const DiscoverAdAccountsSchema = z.object({
  platform: AdPlatformSchema,
  accessToken: z.string().min(1),
});

export const CreateAudienceSegmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  targeting: TargetingSchema,
});

export const UpdateAudienceSegmentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  targeting: TargetingSchema.optional(),
});

export const DuplicateCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});

export const ApplyAudienceSegmentSchema = z.object({
  campaignId: z.string().uuid(),
});

export const CreateCampaignSchema = z
  .object({
    adAccountId: z.string().uuid(),
    name: z.string().min(1).max(200),
    objective: CampaignObjectiveSchema,
    budgetType: BudgetTypeSchema,
    budgetAmount: z.number().positive(),
    budgetCurrency: z.string().length(3).optional(),
    bidStrategy: CampaignBidStrategySchema.optional(),
    optimizationGoal: CampaignOptimizationGoalSchema.optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    dayparting: DaypartingScheduleSchema.optional(),
    appId: z.string().uuid().optional(),
  })
  .and(TargetingOrSegmentSchema);

export const UpdateCampaignSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    budgetAmount: z.number().positive().optional(),
    bidStrategy: CampaignBidStrategySchema.optional(),
    optimizationGoal: CampaignOptimizationGoalSchema.optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    dayparting: DaypartingScheduleSchema.nullable().optional(),
  })
  .and(TargetingOrSegmentSchema);

export const CreateCreativeSchema = z.object({
  name: z.string().min(1).max(200),
  type: CreativeTypeSchema,
  headline: z.string().max(100).optional(),
  primaryText: z.string().max(500).optional(),
  description: z.string().max(200).optional(),
  callToAction: CallToActionSchema.optional(),
  destinationUrl: z.string().url().optional(),
  media: z.array(CreativeMediaSchema),
  pageId: z.string().min(1).optional(),
  instagramActorId: z.string().min(1).optional(),
  tiktokIdentityId: z.string().min(1).optional(),
  tiktokIdentityType: z.string().min(1).optional(),
});

export const UpdateCreativeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  headline: z.string().max(100).optional(),
  primaryText: z.string().max(500).optional(),
  description: z.string().max(200).optional(),
  callToAction: CallToActionSchema.optional(),
  destinationUrl: z.string().url().optional(),
  media: z.array(CreativeMediaSchema).optional(),
});

export const UploadMediaSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: MediaTypeSchema,
  url: z.string().url(),
  mimeType: z.string().min(1).max(120).optional(),
  thumbnailUrl: z.string().url().optional(),
});

export const CampaignIdSchema = z.object({
  campaignId: z.string().uuid(),
});

export const DateRangeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const ListAccountsSchema = z.object({
  platform: AdPlatformSchema.optional(),
});

export const ListCampaignsSchema = z.object({
  adAccountId: z.string().uuid().optional(),
  platform: AdPlatformSchema.optional(),
  status: z.string().optional(),
  appId: z.string().uuid().optional(),
});

export const GetAnalyticsSchema = CampaignIdSchema.merge(DateRangeSchema);

export const CreateAttributionLinkSchema = z.object({
  destinationUrl: z.string().url(),
  creativeId: z.string().uuid().optional(),
  source: z.string().trim().min(1).max(80).optional(),
  medium: z.string().trim().min(1).max(80).optional(),
  content: z.string().trim().min(1).max(120).optional(),
  term: z.string().trim().min(1).max(120).optional(),
});

export const ConversionEventTypeSchema = z.enum([
  "conversion",
  "purchase",
  "signup",
  "lead",
  "install",
  "custom",
]);

export const RecordConversionSchema = z.object({
  token: z.string().min(20),
  eventType: ConversionEventTypeSchema.default("conversion"),
  dedupeKey: z.string().trim().min(1).max(180),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).default("USD"),
  sourceUrl: z.string().url().optional(),
  referrer: z.string().url().optional(),
  userAgent: z.string().max(512).optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
