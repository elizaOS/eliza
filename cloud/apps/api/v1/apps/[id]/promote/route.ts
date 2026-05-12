import { Hono } from "hono";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appPromotionService, type PromotionConfig } from "@/lib/services/app-promotion";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const SocialPlatformSchema = z.enum([
  "twitter",
  "bluesky",
  "discord",
  "telegram",
  "slack",
  "reddit",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "mastodon",
]);

const PromotionConfigSchema = z.object({
  channels: z
    .array(
      z.enum([
        "social",
        "seo",
        "advertising",
        "twitter_automation",
        "telegram_automation",
        "discord_automation",
      ]),
    )
    .min(1),
  social: z
    .object({
      platforms: z.array(SocialPlatformSchema).min(1),
      customMessage: z.string().max(2000).optional(),
      includeScreenshot: z.boolean().optional(),
    })
    .optional(),
  seo: z
    .object({
      generateMeta: z.boolean().optional(),
      generateSchema: z.boolean().optional(),
      submitToIndexNow: z.boolean().optional(),
    })
    .optional(),
  advertising: z
    .object({
      platform: z.enum(["meta", "google", "tiktok"]),
      adAccountId: z.string().uuid(),
      budget: z.number().positive().max(10000),
      budgetType: z.enum(["daily", "lifetime"]),
      objective: z.enum(["awareness", "traffic", "engagement", "app_promotion"]),
      duration: z.number().int().positive().max(365).optional(),
      targetLocations: z.array(z.string().length(2)).max(50).optional(),
    })
    .optional(),
  twitterAutomation: z
    .object({
      enabled: z.boolean(),
      autoPost: z.boolean(),
      autoReply: z.boolean(),
      autoEngage: z.boolean(),
      discovery: z.boolean(),
      postIntervalMin: z.number().int().min(30).max(1440).default(90),
      postIntervalMax: z.number().int().min(60).max(1440).default(150),
      vibeStyle: z.string().max(100).optional(),
      topics: z.array(z.string().max(50)).max(10).optional(),
      agentCharacterId: z.string().uuid().optional(),
    })
    .optional(),
  telegramAutomation: z
    .object({
      useExisting: z.boolean().optional(), // If true, just post using existing config
      enabled: z.boolean().optional(),
      channelId: z.string().optional(),
      groupId: z.string().optional(),
      autoAnnounce: z.boolean().optional(),
      autoReply: z.boolean().optional(),
      announceIntervalMin: z.number().int().min(30).max(1440).default(60),
      announceIntervalMax: z.number().int().min(60).max(1440).default(120),
      vibeStyle: z.string().max(100).optional(),
      agentCharacterId: z.string().uuid().optional(),
    })
    .optional(),
  discordAutomation: z
    .object({
      useExisting: z.boolean().optional(), // If true, just post using existing config
      enabled: z.boolean().optional().default(true),
      guildId: z.string().optional(),
      channelId: z.string().optional(),
      autoAnnounce: z.boolean().optional().default(true),
      announceIntervalMin: z.number().int().min(30).max(1440).default(60),
      announceIntervalMax: z.number().int().min(60).max(1440).default(120),
      vibeStyle: z.string().max(100).optional(),
      agentCharacterId: z.string().uuid().optional(),
    })
    .optional(),
});

async function __hono_GET(request: Request, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const url = new URL(request.url);
  const isHistory = url.searchParams.get("history") === "true";

  if (isHistory) {
    const history = await appPromotionService.getPromotionHistory(user.organization_id, id);
    return Response.json(history);
  }

  const suggestions = await appPromotionService.getPromotionSuggestions(user.organization_id, id);

  return Response.json(suggestions);
}

async function __hono_POST(request: Request, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const body = await request.json();
  const parsed = PromotionConfigSchema.safeParse(body);

  if (!parsed.success) {
    const receivedChannels =
      body && typeof body === "object" && "channels" in body
        ? (body as { channels: unknown }).channels
        : undefined;
    logger.warn("[Promote API] Validation failed", {
      appId: id,
      errors: parsed.error.flatten(),
      receivedChannels,
    });
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const config = parsed.data as PromotionConfig;

  // Validate channel-specific config
  if (config.channels.includes("social") && !config.social) {
    return Response.json(
      { error: "Social config required when social channel is selected" },
      { status: 400 },
    );
  }

  if (config.channels.includes("advertising") && !config.advertising) {
    return Response.json(
      {
        error: "Advertising config required when advertising channel is selected",
      },
      { status: 400 },
    );
  }

  if (config.channels.includes("twitter_automation") && !config.twitterAutomation) {
    return Response.json(
      {
        error: "Twitter automation config required when twitter_automation channel is selected",
      },
      { status: 400 },
    );
  }

  if (config.channels.includes("telegram_automation") && !config.telegramAutomation) {
    return Response.json(
      {
        error: "Telegram automation config required when telegram_automation channel is selected",
      },
      { status: 400 },
    );
  }

  if (config.channels.includes("discord_automation") && !config.discordAutomation) {
    return Response.json(
      {
        error: "Discord automation config required when discord_automation channel is selected",
      },
      { status: 400 },
    );
  }

  logger.info("[Promote API] Starting promotion", {
    appId: id,
    channels: config.channels,
    userId: user.id,
  });

  const result = await appPromotionService.promoteApp(user.organization_id, user.id, id, config);

  logger.info("[Promote API] Promotion complete", {
    appId: id,
    creditsUsed: result.totalCreditsUsed,
    errors: result.errors.length,
  });

  return Response.json(result, {
    status: result.errors.length > 0 ? 207 : 200, // Multi-status if partial success
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
