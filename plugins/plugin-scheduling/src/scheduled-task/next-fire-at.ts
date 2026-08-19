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

import { computeNextCronRunAtMs } from "@elizaos/core/edge";

import type { AnchorRegistry } from "../anchors/anchor-registry.js";
import { windowOccurrenceKey } from "./due.js";
import { resolveLocalHHMMToIso } from "./local-time.js";
import { isRepresentableMs, MAX_DATE_MS } from "./time-range.js";
import { resolveTriggerTz } from "./trigger-tz.js";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskTrigger,
} from "./types.js";
import {
  formatLocalHHMM,
  resolveOwnerWindowBoundsMinutes,
  resolveOwnerWindowSegments,
} from "./window-bounds.js";

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

/** Headroom for core's cron scan window (366 days) before the Date limit. */
const CRON_SCAN_HEADROOM_MS = 366 * 24 * 60 * MINUTE_MS;

function nextWindowStartIso(
  windowKey: string,
  context: ComputeNextFireAtContext,
  task: Pick<ScheduledTask, "state" | "metadata">,
): string | null {
  const facts = context.ownerFacts;
  const timeZone = facts.timezone ?? "UTC";
  const { morningStart, morningEnd, eveningStart, eveningEnd } =
    resolveOwnerWindowBoundsMinutes(facts);
  const activeNames = new Set(
    resolveOwnerWindowSegments(windowKey, facts).map((segment) => segment.name),
  );
  let candidateMinutes: number[];
  switch (windowKey) {
    case "morning":
      candidateMinutes = activeNames.has("morning") ? [morningStart] : [];
      break;
    case "afternoon":
      candidateMinutes = activeNames.has("afternoon") ? [morningEnd] : [];
      break;
    case "evening":
      candidateMinutes = activeNames.has("evening") ? [eveningStart] : [];
      break;
    case "night":
      candidateMinutes = activeNames.has("night") ? [eveningEnd] : [];
      break;
    case "morning_or_night":
      candidateMinutes = [
        ...(activeNames.has("morning") ? [morningStart] : []),
        ...(activeNames.has("night") ? [eveningEnd] : []),
      ];
      break;
    case "morning_or_evening":
      candidateMinutes = [
        ...(activeNames.has("morning") ? [morningStart] : []),
        ...(activeNames.has("evening") ? [eveningStart] : []),
      ];
      break;
    default:
      return null;
  }
  const candidateTimes = candidateMinutes.map(formatLocalHHMM);
  const nowMs = context.now.getTime();

  // An active occurrence is always the next candidate, even when a composite
  // window has another start later today. Reuse the authoritative due helper
  // so the index and due evaluation agree on midnight-spanning occurrences.
  const fireKey = windowOccurrenceKey(context.now, timeZone, windowKey, facts);
  if (fireKey !== null) {
    const firedAtMs = parseIsoMs(task.state.firedAt);
    const alreadyFired =
      task.metadata?.lastWindowFireKey === fireKey ||
      (task.state.status !== "scheduled" &&
        firedAtMs !== null &&
        windowOccurrenceKey(new Date(firedAtMs), timeZone, windowKey, facts) ===
          fireKey);
    if (!alreadyFired) return context.now.toISOString();
  }

  const today = candidateTimes
    .map((hhmm) => resolveLocalHHMMToIso(context.now, hhmm, timeZone, 0))
    .map((iso) => parseIsoMs(iso))
    .filter((ms): ms is number => ms !== null)
    .sort((left, right) => left - right);
  const future = today.find((ms) => ms >= nowMs);
  if (future !== undefined) return new Date(future).toISOString();

  const tomorrow = candidateTimes
    .map((hhmm) => resolveLocalHHMMToIso(context.now, hhmm, timeZone, 1))
    .map((iso) => parseIsoMs(iso))
    .filter((ms): ms is number => ms !== null)
    .sort((left, right) => left - right);
  const earliest = tomorrow[0];
  return earliest === undefined ? null : new Date(earliest).toISOString();
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
        ) => Promise<{ atIso: string } | null> | { atIso: string } | null;
      }
    | null
    | undefined;
  if (typeof registryAnchor?.resolve === "function") {
    const resolved = await registryAnchor.resolve({
      nowIso: context.now.toISOString(),
      ownerFacts,
    });
    if (resolved?.atIso && Number.isFinite(Date.parse(resolved.atIso))) {
      const atMs =
        Date.parse(resolved.atIso) + trigger.offsetMinutes * MINUTE_MS;
      // Extreme offsetMinutes can leave the representable Date range; a
      // non-indexable anchor is NULL, not a crash in the persist path.
      if (!isRepresentableMs(atMs)) return null;
      return new Date(atMs).toISOString();
    }
  }

  const timeZone = ownerFacts.timezone ?? "UTC";
  let baseIso: string | null = null;
  if (
    trigger.anchorKey === "wake.confirmed" ||
    trigger.anchorKey === "wake.observed" ||
    trigger.anchorKey === "morning.start"
  ) {
    baseIso = resolveLocalHHMMToIso(
      context.now,
      ownerFacts.morningWindow?.start,
      timeZone,
    );
  } else if (trigger.anchorKey === "bedtime.target") {
    baseIso =
      resolveLocalHHMMToIso(
        context.now,
        ownerFacts.eveningWindow?.end,
        timeZone,
      ) ?? resolveLocalHHMMToIso(context.now, "22:30", timeZone);
  } else if (trigger.anchorKey === "night.start") {
    baseIso = resolveLocalHHMMToIso(
      context.now,
      ownerFacts.eveningWindow?.start,
      timeZone,
    );
  } else if (trigger.anchorKey === "lunch.start") {
    baseIso = resolveLocalHHMMToIso(context.now, "12:00", timeZone);
  }
  if (!baseIso) return null;
  const atMs = Date.parse(baseIso) + trigger.offsetMinutes * MINUTE_MS;
  if (!isRepresentableMs(atMs)) return null;
  return new Date(atMs).toISOString();
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
  // Scheduled-override first: a `scheduled` row with `state.firedAt` set fires
  // AT that instant (snooze, gate-defer, dispatch-retry — see
  // `scheduledOverrideDue` in due.ts). Recomputing from the trigger here would
  // hide the override from the indexed tick query: a snoozed daily reminder
  // would index at tomorrow's natural occurrence and only fire then, and a
  // snoozed interval task would index at override+interval.
  if (task.state.status === "scheduled") {
    const overrideMs = parseIsoMs(task.state.firedAt);
    if (overrideMs !== null) {
      return new Date(overrideMs).toISOString();
    }
  }
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
      // computeNextCronRunAtMs scans up to ~366 days past the base. A base
      // (garbage firedAt) close enough to the max representable date makes
      // every candidate an Invalid Date: a ~30s scan that can only return
      // null. Bail out with the same null, without the scan.
      if (baseMs > MAX_DATE_MS - CRON_SCAN_HEADROOM_MS) return null;
      const nextMs = computeNextCronRunAtMs(
        trigger.expression,
        baseMs,
        resolveTriggerTz(trigger.tz, context.ownerFacts),
      );
      return nextMs === null ? null : new Date(nextMs).toISOString();
    }
    case "interval": {
      if (!Number.isFinite(trigger.everyMinutes) || trigger.everyMinutes <= 0) {
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
      // A finite-but-huge everyMinutes (schema allows any positive int) can
      // overflow the representable Date range — index as NULL, don't throw.
      if (!isRepresentableMs(candidateMs)) return null;
      return new Date(candidateMs).toISOString();
    }
    case "relative_to_anchor":
      return nextAnchorIso(trigger, context);
    case "during_window":
      return nextWindowStartIso(trigger.windowKey, context, task);
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
