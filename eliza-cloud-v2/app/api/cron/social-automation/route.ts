/**
 * Social Media Automation Cron Job
 *
 * Processes scheduled announcements for:
 * - Discord automation
 * - Telegram automation
 * - Twitter automation
 *
 * Should be called every 5 minutes via Vercel Cron.
 * Protected by CRON_SECRET.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { dbRead } from "@/db/client";
import { apps } from "@/db/schemas";
import { discordAppAutomationService } from "@/lib/services/discord-automation/app-automation";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation/app-automation";
import { twitterAppAutomationService } from "@/lib/services/twitter-automation/app-automation";
import { logger } from "@/lib/utils/logger";
import { sql, or } from "drizzle-orm";
import type { App } from "@/db/schemas/apps";

// Constants for automation intervals
const DEFAULT_INTERVAL_MIN = 120; // 2 hours minimum
const DEFAULT_INTERVAL_MAX = 240; // 4 hours maximum
const MAX_CONCURRENT_POSTS = 5; // Process up to 5 apps concurrently

export const runtime = "nodejs";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

interface AutomationConfig {
  enabled: boolean;
  autoAnnounce?: boolean;
  autoPost?: boolean;
  lastAnnouncementAt?: string;
  lastPostAt?: string;
  announceIntervalMin?: number;
  announceIntervalMax?: number;
  postIntervalMin?: number;
  postIntervalMax?: number;
}

interface ProcessResult {
  appId: string;
  appName: string;
  platform: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Generate a deterministic hash value between 0 and 1 from a string.
 * Used to distribute posts across the time window to avoid rate limit spikes.
 */
function hashToFraction(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Convert to positive fraction between 0 and 1
  return Math.abs(hash % 1000) / 1000;
}

function isAnnouncementDue(
  config: AutomationConfig,
  type: "announcement" | "post",
  appId?: string,
): boolean {
  if (!config.enabled) return false;

  const autoEnabled =
    type === "announcement" ? config.autoAnnounce : config.autoPost;
  if (!autoEnabled) return false;

  const lastTime =
    type === "announcement" ? config.lastAnnouncementAt : config.lastPostAt;
  if (!lastTime) return true;

  const lastDate = new Date(lastTime);
  const now = new Date();
  const minutesSince = (now.getTime() - lastDate.getTime()) / (1000 * 60);

  const minInterval =
    type === "announcement"
      ? (config.announceIntervalMin ?? DEFAULT_INTERVAL_MIN)
      : (config.postIntervalMin ?? DEFAULT_INTERVAL_MIN);
  const maxInterval =
    type === "announcement"
      ? (config.announceIntervalMax ?? DEFAULT_INTERVAL_MAX)
      : (config.postIntervalMax ?? DEFAULT_INTERVAL_MAX);

  // Before min interval: not due
  if (minutesSince < minInterval) return false;
  // After max interval: definitely due
  if (minutesSince >= maxInterval) return true;

  // Between min and max: use hash-based threshold to distribute posts
  // Each app gets a different position in the window based on its ID
  const windowProgress =
    (minutesSince - minInterval) / (maxInterval - minInterval);
  const threshold = appId ? hashToFraction(appId + type) : 0.5;
  return windowProgress >= threshold;
}

async function getAppsWithAutomation(): Promise<App[]> {
  return dbRead
    .select()
    .from(apps)
    .where(
      or(
        sql`${apps.discord_automation}->>'enabled' = 'true'`,
        sql`${apps.telegram_automation}->>'enabled' = 'true'`,
        sql`${apps.twitter_automation}->>'enabled' = 'true'`,
      ),
    );
}

async function processDiscordAutomation(
  app: App,
): Promise<ProcessResult | null> {
  const config = app.discord_automation as AutomationConfig | null;
  if (!config?.enabled || !config.autoAnnounce) return null;

  const isDue = isAnnouncementDue(config, "announcement", app.id);
  if (!isDue) return null;

  const result = await discordAppAutomationService.postAnnouncement(
    app.organization_id,
    app.id,
  );

  return {
    appId: app.id,
    appName: app.name,
    platform: "discord",
    success: result.success,
    messageId: result.messageId,
    error: result.error,
  };
}

async function processTelegramAutomation(
  app: App,
): Promise<ProcessResult | null> {
  const config = app.telegram_automation as AutomationConfig | null;
  if (!config?.enabled || !config.autoAnnounce) return null;

  const isDue = isAnnouncementDue(config, "announcement", app.id);
  if (!isDue) return null;

  const result = await telegramAppAutomationService.postAnnouncement(
    app.organization_id,
    app.id,
  );

  return {
    appId: app.id,
    appName: app.name,
    platform: "telegram",
    success: result.success,
    messageId: result.messageId?.toString(),
    error: result.error,
  };
}

async function processTwitterAutomation(
  app: App,
): Promise<ProcessResult | null> {
  const config = app.twitter_automation as AutomationConfig | null;
  if (!config?.enabled || !config.autoPost) return null;

  const isDue = isAnnouncementDue(config, "post", app.id);
  if (!isDue) return null;

  const result = await twitterAppAutomationService.postAppTweet(
    app.organization_id,
    app.id,
  );

  return {
    appId: app.id,
    appName: app.name,
    platform: "twitter",
    success: result.success,
    messageId: result.tweetId,
    error: result.error,
  };
}

/**
 * Process a single app across all platforms
 */
async function processApp(app: App): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];

  // Process all platforms for this app in parallel
  const [discordResult, telegramResult, twitterResult] = await Promise.all([
    processDiscordAutomation(app).catch((error) => {
      logger.error("[SocialAutomation Cron] Discord error", {
        appId: app.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }),
    processTelegramAutomation(app).catch((error) => {
      logger.error("[SocialAutomation Cron] Telegram error", {
        appId: app.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }),
    processTwitterAutomation(app).catch((error) => {
      logger.error("[SocialAutomation Cron] Twitter error", {
        appId: app.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }),
  ]);

  if (discordResult) {
    results.push(discordResult);
    logger.info("[SocialAutomation Cron] Discord post", {
      appId: app.id,
      success: discordResult.success,
      error: discordResult.error,
    });
  }

  if (telegramResult) {
    results.push(telegramResult);
    logger.info("[SocialAutomation Cron] Telegram post", {
      appId: app.id,
      success: telegramResult.success,
      error: telegramResult.error,
    });
  }

  if (twitterResult) {
    results.push(twitterResult);
    logger.info("[SocialAutomation Cron] Twitter post", {
      appId: app.id,
      success: twitterResult.success,
      error: twitterResult.error,
    });
  }

  return results;
}

/**
 * Process apps in batches with concurrency limit
 */
async function processAppsWithConcurrency(
  apps: App[],
  concurrency: number,
): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];

  // Process in batches
  for (let i = 0; i < apps.length; i += concurrency) {
    const batch = apps.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processApp));
    results.push(...batchResults.flat());
  }

  return results;
}

export async function POST(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  logger.info("[SocialAutomation Cron] Starting");

  const appsWithAutomation = await getAppsWithAutomation();
  logger.info("[SocialAutomation Cron] Found apps with automation", {
    count: appsWithAutomation.length,
  });

  // Process apps in parallel with concurrency limit
  const results = await processAppsWithConcurrency(
    appsWithAutomation,
    MAX_CONCURRENT_POSTS,
  );

  const duration = Date.now() - startTime;
  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  logger.info("[SocialAutomation Cron] Completed", {
    duration,
    appsProcessed: appsWithAutomation.length,
    postsAttempted: results.length,
    successful: successCount,
    failed: failureCount,
  });

  // Return summary + only failures for large result sets
  const failedResults = results.filter((r) => !r.success);

  return NextResponse.json({
    success: true,
    duration,
    stats: {
      appsWithAutomation: appsWithAutomation.length,
      postsAttempted: results.length,
      successful: successCount,
      failed: failureCount,
    },
    // Only include failures in response to reduce payload size
    failures: failedResults,
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appsWithAutomation = await getAppsWithAutomation();

  return NextResponse.json({
    status: "ready",
    description: "Social media automation cron job",
    platforms: ["discord", "telegram", "twitter"],
    appsWithAutomation: appsWithAutomation.length,
    tasks: [
      "Process Discord scheduled announcements",
      "Process Telegram scheduled announcements",
      "Process Twitter scheduled posts",
    ],
  });
}
