/**
 * Computes the indexed `next_fire_at` timestamp for a `ScheduledTask`.
 *
 * The scheduler tick (`processDueScheduledTasks`) filters by this column to
 * avoid scanning every row in `life_scheduled_tasks` once per minute. The
 * value is approximate — it is a "next candidate fire time" that the
 * authoritative `isScheduledTaskDue` re-evaluates per task. Triggers that
 * wake on external signals (`event`, `manual`, `after_task`) leave it NULL.
 *
 * Computed for: `once`, `cron`, `interval`, `relative_to_anchor`,
 * `during_window`.
 *
 * Computed by the runner on every state mutation that can change the
 * upcoming fire time: `schedule()`, `apply("snooze")`, `apply("edit")`, and
 * the post-fire/post-skip persistence in `fire()`.
 */

import { computeNextCronRunAtMs } from "@elizaos/core";

import type { AnchorRegistry } from "../registries/anchor-registry.js";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskTrigger,
} from "./types.js";

const MINUTE_MS = 60_000;

export interface ComputeNextFireAtContext {
  now: Date;
  ownerFacts: OwnerFactsView;
  anchors?: AnchorRegistry | null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesFromHHMM(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function localHHMMToIso(
  now: Date,
  hhmm: string | undefined,
  timeZone: string,
): string | null {
  const minutes = minutesFromHHMM(hhmm);
  if (minutes === null) return null;
  const parts = localParts(now, timeZone);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    minute,
  );
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const offsetParts = offsetFormatter.formatToParts(new Date(localAsUtc));
  const offsetValue =
    offsetParts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offsetMatch = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(offsetValue);
  let offsetMinutes = 0;
  if (offsetMatch) {
    const sign = offsetMatch[1]?.startsWith("-") ? -1 : 1;
    const hours = Math.abs(Number.parseInt(offsetMatch[1] ?? "0", 10));
    const minutesPart = Number.parseInt(offsetMatch[2] ?? "0", 10);
    offsetMinutes = sign * (hours * 60 + minutesPart);
  }
  return new Date(localAsUtc - offsetMinutes * MINUTE_MS).toISOString();
}

function nextWindowStartIso(
  windowKey: string,
  context: ComputeNextFireAtContext,
): string | null {
  const facts = context.ownerFacts;
  const timeZone = facts.timezone ?? "UTC";
  const morningStart = facts.morningWindow?.start;
  const eveningStart = facts.eveningWindow?.start;
  const eveningEnd = facts.eveningWindow?.end;
  let candidates: string[] = [];
  switch (windowKey) {
    case "morning":
      candidates = [localHHMMToIso(context.now, morningStart, timeZone) ?? ""];
      break;
    case "afternoon":
      candidates = [
        localHHMMToIso(context.now, facts.morningWindow?.end, timeZone) ?? "",
      ];
      break;
    case "evening":
      candidates = [localHHMMToIso(context.now, eveningStart, timeZone) ?? ""];
      break;
    case "night":
      candidates = [
        localHHMMToIso(context.now, eveningEnd, timeZone) ?? "",
        localHHMMToIso(context.now, "00:00", timeZone) ?? "",
      ];
      break;
    case "morning_or_night":
      candidates = [
        localHHMMToIso(context.now, morningStart, timeZone) ?? "",
        localHHMMToIso(context.now, eveningEnd, timeZone) ?? "",
      ];
      break;
    case "morning_or_evening":
      candidates = [
        localHHMMToIso(context.now, morningStart, timeZone) ?? "",
        localHHMMToIso(context.now, eveningStart, timeZone) ?? "",
      ];
      break;
    default:
      return null;
  }
  const nowMs = context.now.getTime();
  const upcoming = candidates
    .map((iso) => parseIsoMs(iso))
    .filter((ms): ms is number => ms !== null);
  if (upcoming.length === 0) return null;
  const future = upcoming.find((ms) => ms >= nowMs);
  if (future !== undefined) return new Date(future).toISOString();
  // All today's window-starts are in the past; bump to same local-HHMM
  // tomorrow. The runner re-computes after each fire, so we only need a
  // coarse "tomorrow morning" candidate here.
  const earliest = Math.min(...upcoming);
  return new Date(earliest + 24 * 60 * MINUTE_MS).toISOString();
}

async function nextAnchorIso(
  trigger: Extract<ScheduledTaskTrigger, { kind: "relative_to_anchor" }>,
  context: ComputeNextFireAtContext,
): Promise<string | null> {
  const ownerFacts = context.ownerFacts;
  const registryAnchor = context.anchors?.get(trigger.anchorKey) as
    | {
        resolve?: (
          ctx: unknown,
        ) =>
          | Promise<{ atIso: string } | null>
          | { atIso: string }
          | null;
      }
    | null
    | undefined;
  if (typeof registryAnchor?.resolve === "function") {
    const resolved = await registryAnchor.resolve({
      nowIso: context.now.toISOString(),
      ownerFacts,
    });
    if (resolved?.atIso && Number.isFinite(Date.parse(resolved.atIso))) {
      return new Date(
        Date.parse(resolved.atIso) + trigger.offsetMinutes * MINUTE_MS,
      ).toISOString();
    }
  }

  const timeZone = ownerFacts.timezone ?? "UTC";
  let baseIso: string | null = null;
  if (
    trigger.anchorKey === "wake.confirmed" ||
    trigger.anchorKey === "wake.observed" ||
    trigger.anchorKey === "morning.start"
  ) {
    baseIso = localHHMMToIso(
      context.now,
      ownerFacts.morningWindow?.start,
      timeZone,
    );
  } else if (trigger.anchorKey === "bedtime.target") {
    baseIso =
      localHHMMToIso(context.now, ownerFacts.eveningWindow?.end, timeZone) ??
      localHHMMToIso(context.now, "22:30", timeZone);
  } else if (trigger.anchorKey === "night.start") {
    baseIso = localHHMMToIso(
      context.now,
      ownerFacts.eveningWindow?.start,
      timeZone,
    );
  } else if (trigger.anchorKey === "lunch.start") {
    baseIso = localHHMMToIso(context.now, "12:00", timeZone);
  }
  if (!baseIso) return null;
  return new Date(
    Date.parse(baseIso) + trigger.offsetMinutes * MINUTE_MS,
  ).toISOString();
}

/**
 * Compute the next-fire-at timestamp for a task. Returns null when the
 * trigger does not have a wall-clock fire time (event/manual/after_task)
 * or when the inputs cannot be resolved (e.g. unknown anchor key).
 *
 * The function is async because anchor resolution may consult the runtime
 * anchor registry (e.g. `wake.confirmed` reads the latest activity signal).
 *
 * Inputs:
 *  - `task`: must have its current `trigger` and (post-fire) `state.firedAt`.
 *  - `context.now`: clock used for forward-projecting cron/interval/window.
 *
 * Outputs an ISO string, never a Date — the caller writes directly to a
 * Postgres timestamp column.
 */
export async function computeNextFireAt(
  task: Pick<ScheduledTask, "trigger" | "state" | "metadata">,
  context: ComputeNextFireAtContext,
): Promise<string | null> {
  const trigger = task.trigger;
  switch (trigger.kind) {
    case "once": {
      if (task.state.firedAt) return null;
      const at = Date.parse(trigger.atIso);
      if (!Number.isFinite(at)) return null;
      return new Date(at).toISOString();
    }
    case "cron": {
      const lastFire = parseIsoMs(task.state.firedAt);
      const baseMs =
        lastFire !== null && lastFire >= context.now.getTime()
          ? lastFire
          : context.now.getTime();
      const nextMs = computeNextCronRunAtMs(
        trigger.expression,
        baseMs,
        trigger.tz,
      );
      return nextMs === null ? null : new Date(nextMs).toISOString();
    }
    case "interval": {
      if (
        !Number.isFinite(trigger.everyMinutes) ||
        trigger.everyMinutes <= 0
      ) {
        return null;
      }
      const fromMs = parseIsoMs(trigger.from);
      const untilMs = parseIsoMs(trigger.until);
      const lastFireMs = parseIsoMs(task.state.firedAt);
      const candidateMs =
        lastFireMs !== null
          ? lastFireMs + trigger.everyMinutes * MINUTE_MS
          : (fromMs ?? context.now.getTime());
      if (untilMs !== null && candidateMs > untilMs) return null;
      return new Date(candidateMs).toISOString();
    }
    case "relative_to_anchor":
      return nextAnchorIso(trigger, context);
    case "during_window":
      return nextWindowStartIso(trigger.windowKey, context);
    case "event":
    case "manual":
    case "after_task":
      return null;
    default: {
      const _exhaustive: never = trigger;
      return null;
    }
  }
}
