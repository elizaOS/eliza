import { ok, serverError, unauthorized } from "@/lib/api-utils";
import { sendMatchReveals, sendMeetingReminders } from "@/lib/engine-notify";
import {
  acquireEngineLock,
  loadEngineState,
  releaseEngineLock,
  saveEngineState,
} from "@/lib/engine-store";
import { readBooleanEnv, readEnv, readNumberEnv } from "@/lib/env";
import type { OutboundChannel } from "@/lib/twilio-messaging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CronStatus = "ok" | "skipped";

type ReminderResponse = {
  status: CronStatus;
  durationMs: number;
  sent: number;
  failed: number;
  skipped: number;
  reason?: string;
};

const resolveChannel = (value: string | null): OutboundChannel =>
  value === "whatsapp" ? "whatsapp" : "sms";

const parseWindowMinutes = (value: string | null): number[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.floor(entry));
};

const isAuthorized = (request: Request): boolean => {
  const secret = readEnv("SOULMATES_CRON_SECRET");
  if (!secret) return true;
  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const cronHeader = request.headers.get("x-cron-secret");
  return bearer === secret || cronHeader === secret;
};

async function handleCron(request: Request) {
  if (!isAuthorized(request)) {
    return unauthorized();
  }

  const enabled = readBooleanEnv("SOULMATES_REMINDERS_ENABLED", false);
  if (!enabled) {
    return ok({
      status: "skipped",
      reason: "disabled",
      durationMs: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    } satisfies ReminderResponse);
  }

  const lockMs = readNumberEnv("SOULMATES_REMINDERS_LOCK_MS", 60_000);
  const locked = await acquireEngineLock(lockMs);
  if (!locked) {
    return ok({
      status: "skipped",
      reason: "locked",
      durationMs: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    } satisfies ReminderResponse);
  }

  const start = Date.now();
  try {
    const record = await loadEngineState();
    const configuredWindows = parseWindowMinutes(
      readEnv("SOULMATES_REMINDER_WINDOWS_MINUTES"),
    );
    const windows =
      configuredWindows.length > 0 ? configuredWindows : [1440, 120];
    const toleranceMinutes = Math.max(
      1,
      Math.floor(readNumberEnv("SOULMATES_REMINDER_TOLERANCE_MINUTES", 10)),
    );
    const channel = resolveChannel(
      readEnv("SOULMATES_REMINDER_CHANNEL") ??
        readEnv("SOULMATES_MATCHING_CHANNEL"),
    );

    const revealResult = await sendMatchReveals(record.state, {
      channel,
      phase2Hours: readNumberEnv("SOULMATES_MATCH_REVEAL_PHASE2_HOURS", 6),
      phase3Hours: readNumberEnv("SOULMATES_MATCH_REVEAL_PHASE3_HOURS", 12),
      phase4Hours: readNumberEnv("SOULMATES_MATCH_REVEAL_PHASE4_HOURS", 18),
      now: new Date(),
    });

    const result = await sendMeetingReminders(revealResult.state, {
      channel,
      windowsMinutes: windows,
      toleranceMinutes,
      now: new Date(),
    });

    const durationMs = Date.now() - start;
    await saveEngineState({
      state: result.state,
      cursor: record.cursor,
      lastRunAt: new Date(),
      lastRunDurationMs: durationMs,
      lockedUntil: null,
    });

    return ok({
      status: "ok",
      durationMs,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
    } satisfies ReminderResponse);
  } catch (err) {
    await releaseEngineLock();
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Cron] Reminder run failed:", message);
    return serverError("Reminder cron failed.");
  }
}

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}
