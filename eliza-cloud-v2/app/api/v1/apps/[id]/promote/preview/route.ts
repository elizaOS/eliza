/**
 * Promotion Preview API
 *
 * Generates preview posts for different platforms before launching promotion.
 * Returns AI-generated sample posts for Discord, Telegram, and Twitter.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { discordAppAutomationService } from "@/lib/services/discord-automation/app-automation";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation/app-automation";
import { twitterAppAutomationService } from "@/lib/services/twitter-automation/app-automation";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Generating multiple AI posts per platform can take time

interface RouteParams {
  params: Promise<{ id: string }>;
}

const PreviewRequestSchema = z.object({
  platforms: z.array(z.enum(["discord", "telegram", "twitter"])).min(1),
  count: z.number().int().min(1).max(4).default(3),
  agentCharacterId: z.string().uuid().optional(),
});

interface PostPreview {
  platform: "discord" | "telegram" | "twitter";
  content: string;
  type: string;
  timestamp: string;
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const body = await request.json();
  const parsed = PreviewRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { platforms, count, agentCharacterId } = parsed.data;

  const app = await appsService.getById(id);
  if (!app || app.organization_id !== user.organization_id) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  // Create a preview app object with the selected character for generation
  // This allows previews to use the character voice without persisting to DB
  const previewApp = agentCharacterId
    ? {
        ...app,
        twitter_automation: {
          ...(app.twitter_automation || {}),
          agentCharacterId,
        },
        discord_automation: {
          ...(app.discord_automation || {}),
          agentCharacterId,
        },
        telegram_automation: {
          ...(app.telegram_automation || {}),
          agentCharacterId,
        },
      }
    : app;

  logger.info("[Promote Preview API] Generating previews", {
    appId: id,
    platforms,
    count,
    agentCharacterId,
  });

  const previews: PostPreview[] = [];
  const errors: string[] = [];

  // Generate previews in parallel for each platform
  const generatePromises: Promise<void>[] = [];

  if (platforms.includes("discord")) {
    generatePromises.push(
      (async () => {
        const postTypes = [
          "promotional",
          "engagement",
          "educational",
          "announcement",
        ] as const;
        for (let i = 0; i < Math.min(count, postTypes.length); i++) {
          const content =
            await discordAppAutomationService.generateAnnouncement(
              user.organization_id,
              previewApp,
            );
          previews.push({
            platform: "discord",
            content,
            type: postTypes[i % postTypes.length],
            timestamp: new Date().toISOString(),
          });
        }
      })().catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error("[Promote Preview API] Discord generation failed", {
          appId: id,
          error: errorMessage,
        });
        errors.push(`Discord: ${errorMessage}`);
      }),
    );
  }

  if (platforms.includes("telegram")) {
    generatePromises.push(
      (async () => {
        const postTypes = [
          "announcement",
          "update",
          "feature",
          "community",
        ] as const;
        for (let i = 0; i < Math.min(count, postTypes.length); i++) {
          const content =
            await telegramAppAutomationService.generateAnnouncement(
              user.organization_id,
              previewApp,
            );
          previews.push({
            platform: "telegram",
            content,
            type: postTypes[i % postTypes.length],
            timestamp: new Date().toISOString(),
          });
        }
      })().catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error("[Promote Preview API] Telegram generation failed", {
          appId: id,
          error: errorMessage,
        });
        errors.push(`Telegram: ${errorMessage}`);
      }),
    );
  }

  if (platforms.includes("twitter")) {
    generatePromises.push(
      (async () => {
        const tweetTypes = [
          "promotional",
          "engagement",
          "educational",
          "announcement",
        ] as const;
        for (let i = 0; i < Math.min(count, tweetTypes.length); i++) {
          const tweet = await twitterAppAutomationService.generateAppTweet(
            user.organization_id,
            previewApp,
            tweetTypes[i % tweetTypes.length],
          );
          previews.push({
            platform: "twitter",
            content: tweet.text,
            type: tweet.type,
            timestamp: new Date().toISOString(),
          });
        }
      })().catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error("[Promote Preview API] Twitter generation failed", {
          appId: id,
          error: errorMessage,
        });
        errors.push(`Twitter: ${errorMessage}`);
      }),
    );
  }

  await Promise.all(generatePromises);

  logger.info("[Promote Preview API] Generated previews", {
    appId: id,
    previewCount: previews.length,
    errorCount: errors.length,
  });

  return NextResponse.json({
    app: {
      id: app.id,
      name: app.name,
      description: app.description,
      url: app.website_url || app.app_url,
      logoUrl: app.logo_url,
    },
    previews,
    errors: errors.length > 0 ? errors : undefined,
  });
}
