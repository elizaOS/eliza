/**
 * Internal Cron Scheduler
 *
 * Triggers additional cron jobs from within game-tick since Vercel Cron
 * only runs on production deployments. This allows staging to run all crons.
 */

import { logger } from "@feed/shared";

interface CronSchedule {
  path: string;
  /** Cron expression: minute hour dayOfMonth month dayOfWeek */
  schedule: string;
  /** Human-readable description */
  description: string;
}

/**
 * Additional crons to trigger from game-tick.
 * Excludes game-tick (already running), agent-tick, reputation-sync, realtime-drain
 * (already showing in Vercel dashboard)
 */
const ADDITIONAL_CRONS: CronSchedule[] = [
  {
    path: "/api/cron/metrics-snapshot",
    schedule: "0 * * * *", // Every hour at minute 0
    description: "Hourly metrics snapshot",
  },
  {
    path: "/api/cron/markets-tick",
    schedule: "* * * * *", // Every minute
    description: "Markets tick",
  },
  {
    path: "/api/cron/npc-tick",
    schedule: "*/2 * * * *", // Every 2 minutes
    description: "NPC tick",
  },
  {
    path: "/api/cron/organization-tick",
    schedule: "*/5 * * * *", // Every 5 minutes
    description: "Organization tick",
  },
  {
    path: "/api/cron/article-tick",
    schedule: "*/30 * * * *", // Every 30 minutes
    description: "Article tick",
  },
  {
    path: "/api/cron/perp-funding",
    schedule: "0 */8 * * *", // Every 8 hours at minute 0
    description: "Perp funding",
  },
  {
    path: "/api/cron/world-facts",
    schedule: "0 6,18 * * *", // At 6 AM and 6 PM
    description: "World facts generation",
  },
  {
    path: "/api/cron/health-check",
    schedule: "*/5 * * * *", // Every 5 minutes
    description: "Health check",
  },
  {
    path: "/api/cron/training-check",
    schedule: "0 * * * *", // Every hour at minute 0
    description: "Training check",
  },
  {
    path: "/api/cron/profile-chain-sync",
    schedule: "0 */6 * * *", // Every 6 hours at minute 0
    description: "Profile chain sync",
  },
  {
    path: "/api/cron/whitelist-topn",
    schedule: "0 0 * * *", // Daily at 00:00 UTC
    description: "Auto-whitelist leaderboard Top N (permanent access)",
  },
];

/**
 * Check if a cron should run based on its schedule and current time
 */
function shouldRunCron(schedule: string, now: Date): boolean {
  const parts = schedule.split(" ");
  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";
  const dayOfMonth = parts[2] ?? "*";
  const month = parts[3] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  const currentMinute = now.getUTCMinutes();
  const currentHour = now.getUTCHours();
  const currentDayOfMonth = now.getUTCDate();
  const currentMonth = now.getUTCMonth() + 1; // 1-indexed
  const currentDayOfWeek = now.getUTCDay(); // 0 = Sunday

  return (
    matchesCronField(minute, currentMinute) &&
    matchesCronField(hour, currentHour) &&
    matchesCronField(dayOfMonth, currentDayOfMonth) &&
    matchesCronField(month, currentMonth) &&
    matchesCronField(dayOfWeek, currentDayOfWeek)
  );
}

/**
 * Check if a cron field matches the current value
 * Supports: *, specific values, comma-separated lists, and step values (e.g., *\/5)
 */
function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  // Handle step values (e.g., */5)
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }

  // Handle comma-separated values (e.g., 6,18)
  if (field.includes(",")) {
    const values = field.split(",").map((v) => parseInt(v, 10));
    return values.includes(value);
  }

  // Handle range (e.g., 1-5) - basic support
  if (field.includes("-")) {
    const rangeParts = field.split("-").map((v) => parseInt(v, 10));
    const start = rangeParts[0] ?? 0;
    const end = rangeParts[1] ?? 0;
    return value >= start && value <= end;
  }

  // Single value
  return parseInt(field, 10) === value;
}

/**
 * Trigger additional crons that should run at the current time.
 * Called from game-tick to ensure all crons run even on staging.
 */
export async function triggerScheduledCrons(): Promise<{
  triggered: string[];
  failed: string[];
  skipped: string[];
}> {
  const now = new Date();
  const triggered: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  // Get base URL for internal API calls
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.warn(
      "CRON_SECRET not set - cannot trigger internal crons",
      undefined,
      "CronScheduler",
    );
    return {
      triggered: [],
      failed: [],
      skipped: ADDITIONAL_CRONS.map((c) => c.path),
    };
  }

  for (const cron of ADDITIONAL_CRONS) {
    if (!shouldRunCron(cron.schedule, now)) {
      skipped.push(cron.path);
      continue;
    }

    try {
      logger.info(
        `Triggering internal cron: ${cron.description}`,
        { path: cron.path, schedule: cron.schedule },
        "CronScheduler",
      );

      const response = await fetch(`${baseUrl}${cron.path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          "User-Agent": "vercel-cron/1.0 (internal-scheduler)",
        },
        // Don't wait too long for each cron
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        triggered.push(cron.path);
        logger.info(
          `✓ Cron triggered successfully: ${cron.path}`,
          { status: response.status },
          "CronScheduler",
        );
      } else {
        failed.push(cron.path);
        logger.warn(
          `✗ Cron failed: ${cron.path}`,
          { status: response.status, statusText: response.statusText },
          "CronScheduler",
        );
      }
    } catch (error) {
      failed.push(cron.path);
      logger.error(
        `✗ Cron error: ${cron.path}`,
        { error: error instanceof Error ? error.message : String(error) },
        "CronScheduler",
      );
    }
  }

  logger.info(
    "Internal cron scheduler complete",
    {
      triggered: triggered.length,
      failed: failed.length,
      skipped: skipped.length,
      triggeredPaths: triggered,
      failedPaths: failed,
    },
    "CronScheduler",
  );

  return { triggered, failed, skipped };
}

/**
 * Check if internal cron scheduling is enabled.
 * Only enable on non-production or when explicitly enabled.
 */
export function isInternalCronSchedulerEnabled(): boolean {
  // Always enable if explicitly set
  if (process.env.ENABLE_INTERNAL_CRON_SCHEDULER === "true") {
    return true;
  }

  // Enable on staging/preview (not production)
  const isProduction = process.env.VERCEL_ENV === "production";
  return !isProduction;
}

let internalCronLoopHandle: ReturnType<typeof setInterval> | null = null;
let internalCronInFlight = false;

/**
 * Entry crons fired by the in-process loop. `game-tick` fans the rest of the
 * scheduled crons out via {@link triggerScheduledCrons}; `agent-tick` and
 * `realtime-drain` are excluded from that fan-out so they are fired here.
 */
const INTERNAL_LOOP_ENTRY_CRONS = [
  "/api/cron/game-tick",
  "/api/cron/agent-tick",
  "/api/cron/realtime-drain",
];

/**
 * Start an in-process scheduler that periodically fires the game loop's entry
 * crons, so a single always-on web service (e.g. on Railway) runs the live game
 * with no external cron infrastructure. No-op unless
 * `ENABLE_INTERNAL_CRON_SCHEDULER === "true"`. Idempotent — safe to call once at
 * server startup.
 */
export function startInternalCronLoop(): void {
  if (process.env.ENABLE_INTERNAL_CRON_SCHEDULER !== "true") return;
  if (internalCronLoopHandle) return;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.warn(
      "ENABLE_INTERNAL_CRON_SCHEDULER is set but CRON_SECRET is missing — internal cron loop disabled",
      undefined,
      "CronScheduler",
    );
    return;
  }

  const port = process.env.PORT ?? "3000";
  const baseUrl =
    process.env.INTERNAL_CRON_URL?.replace(/\/+$/, "") ??
    `http://127.0.0.1:${port}`;

  const fire = async (): Promise<void> => {
    if (internalCronInFlight) return; // skip overlapping ticks
    internalCronInFlight = true;
    try {
      for (const path of INTERNAL_LOOP_ENTRY_CRONS) {
        try {
          await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${cronSecret}` },
            signal: AbortSignal.timeout(120_000),
          });
        } catch (error) {
          logger.warn(
            `Internal cron loop failed to fire ${path}`,
            { error: error instanceof Error ? error.message : String(error) },
            "CronScheduler",
          );
        }
      }
    } finally {
      internalCronInFlight = false;
    }
  };

  internalCronLoopHandle = setInterval(() => {
    void fire();
  }, 60_000);

  logger.info(
    "Internal cron loop started — single-service game loop active",
    { baseUrl, intervalSeconds: 60 },
    "CronScheduler",
  );
}
