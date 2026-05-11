import { z } from "zod";

export const AdPlatformSchema = z.enum(["meta", "google", "tiktok"]);

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

export const TargetingSchema = z.object({
  locations: z.array(z.string()).optional(),
  ageMin: z.number().min(13).max(65).optional(),
  ageMax: z.number().min(13).max(65).optional(),
  genders: z.array(z.enum(["male", "female", "all"])).optional(),
  interests: z.array(z.string()).optional(),
  behaviors: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
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

export const CreateCampaignSchema = z.object({
  adAccountId: z.string().uuid(),
  name: z.string().min(1).max(200),
  objective: CampaignObjectiveSchema,
  budgetType: BudgetTypeSchema,
  budgetAmount: z.number().positive(),
  budgetCurrency: z.string().length(3).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  targeting: TargetingSchema.optional(),
  appId: z.string().uuid().optional(),
});

export const UpdateCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  budgetAmount: z.number().positive().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  targeting: TargetingSchema.optional(),
});

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
