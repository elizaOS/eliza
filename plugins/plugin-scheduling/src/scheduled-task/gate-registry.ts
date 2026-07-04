/**
 * TaskGateRegistry. Built-in kinds: `weekend_skip`, `weekend_only`,
 * `weekday_only`, `late_evening_skip`, `quiet_hours`, `during_travel`,
 * `circadian_state_in`, `no_recent_user_message_in`,
 * `personal_baseline_sufficient`.
 *
 * The runner uses these gates in `shouldFire.gates`; composition is
 * the responsibility of the runner (`compose: "all" | "any" | "first_deny"`).
 */

import type {
  GateDecision,
  GateEvaluationContext,
  TaskGateContribution,
} from "./types.js";

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value: unknown): { hours: number; minutes: number } | null {
  if (typeof value !== "string") return null;
  const match = HHMM_PATTERN.exec(value);
  if (!match) return null;
  return {
    hours: Number.parseInt(match[1] ?? "0", 10),
    minutes: Number.parseInt(match[2] ?? "0", 10),
  };
}

function intInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Resolve the local hour/minute/dayOfWeek for the given iso instant in the
 * given IANA tz. Returns `null` if the timezone is invalid (caller falls
 * back to UTC reading).
 *
 * `dayOfWeek`: 0 = Sunday, 6 = Saturday.
 */
function localPartsAtTz(
  iso: string,
  tz: string,
): { hours: number; minutes: number; dayOfWeek: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    const parts = formatter.formatToParts(date);
    let hours = 0;
    let minutes = 0;
    let weekday = "Sun";
    for (const part of parts) {
      if (part.type === "hour") hours = Number.parseInt(part.value, 10) % 24;
      else if (part.type === "minute")
        minutes = Number.parseInt(part.value, 10);
      else if (part.type === "weekday") weekday = part.value;
    }
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const dayOfWeek = map[weekday] ?? 0;
    if (!intInRange(hours, 0, 23) || !intInRange(minutes, 0, 59)) return null;
    return { hours, minutes, dayOfWeek };
  } catch {
    return null;
  }
}

function localPartsForContext(context: GateEvaluationContext): {
  hours: number;
  minutes: number;
  dayOfWeek: number;
} {
  const tz = context.ownerFacts.timezone ?? "UTC";
  return (
    localPartsAtTz(context.nowIso, tz) ??
    localPartsAtTz(context.nowIso, "UTC") ?? {
      hours: 0,
      minutes: 0,
      dayOfWeek: 0,
    }
  );
}

function isWeekend(dayOfWeek: number): boolean {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

// ---------------------------------------------------------------------------
// Built-in gate kinds
// ---------------------------------------------------------------------------

// Gates return `deny` to mark "skipped" — the runner translates that
// into `state.status = "skipped"`. A `defer` would reschedule; weekend_skip
// is meant to silently drop the fire.
const weekendSkipGate: TaskGateContribution = {
  kind: "weekend_skip",
  evaluate(_task, context): GateDecision {
    const { dayOfWeek } = localPartsForContext(context);
    if (!isWeekend(dayOfWeek)) {
      return { kind: "allow" };
    }
    return { kind: "deny", reason: "weekend_skip: today is a weekend" };
  },
};

const weekendOnlyGate: TaskGateContribution = {
  kind: "weekend_only",
  evaluate(_task, context): GateDecision {
    const { dayOfWeek } = localPartsForContext(context);
    if (isWeekend(dayOfWeek)) {
      return { kind: "allow" };
    }
    return { kind: "deny", reason: "weekend_only: today is a weekday" };
  },
};

interface WeekdayOnlyParams {
  /**
   * Days-of-week the task may fire on (0 = Sunday … 6 = Saturday), e.g.
   * `[1, 3, 5]` for Mon/Wed/Fri habits. When absent or empty, the gate
   * allows any non-weekend day.
   */
  weekdays?: number[];
}

const weekdayOnlyGate: TaskGateContribution = {
  kind: "weekday_only",
  evaluate(_task, context): GateDecision {
    const params = (context.task.shouldFire?.gates.find(
      (g) => g.kind === "weekday_only",
    )?.params ?? {}) as WeekdayOnlyParams;
    const { dayOfWeek } = localPartsForContext(context);
    const allowedDays = Array.isArray(params.weekdays)
      ? params.weekdays.filter(
          (d) => Number.isInteger(d) && intInRange(d, 0, 6),
        )
      : [];
    if (allowedDays.length > 0) {
      if (allowedDays.includes(dayOfWeek)) {
        return { kind: "allow" };
      }
      return {
        kind: "deny",
        reason: `weekday_only: day ${dayOfWeek} not in [${allowedDays.join(",")}]`,
      };
    }
    if (!isWeekend(dayOfWeek)) {
      return { kind: "allow" };
    }
    return { kind: "deny", reason: "weekday_only: today is a weekend" };
  },
};

interface LateEveningSkipParams {
  /** Hour-of-day (0-23) in owner timezone. Default 21 (9pm). */
  afterHour?: number;
}

const lateEveningSkipGate: TaskGateContribution = {
  kind: "late_evening_skip",
  evaluate(_task, context): GateDecision {
    const params = (context.task.shouldFire?.gates.find(
      (g) => g.kind === "late_evening_skip",
    )?.params ?? {}) as LateEveningSkipParams;
    const afterHour = intInRange(params.afterHour ?? -1, 0, 23)
      ? (params.afterHour as number)
      : 21;
    const { hours } = localPartsForContext(context);
    if (hours < afterHour) {
      return { kind: "allow" };
    }
    return {
      kind: "deny",
      reason: `late_evening_skip: hour ${hours} >= ${afterHour}`,
    };
  },
};

interface QuietHoursParams {
  /** When true, `high` priority tasks bypass this gate. Default true. */
  highPriorityBypass?: boolean;
}

const quietHoursGate: TaskGateContribution = {
  kind: "quiet_hours",
  evaluate(task, context): GateDecision {
    const params = (context.task.shouldFire?.gates.find(
      (g) => g.kind === "quiet_hours",
    )?.params ?? {}) as QuietHoursParams;
    const highBypass = params.highPriorityBypass !== false;
    if (highBypass && task.priority === "high") {
      return { kind: "allow" };
    }
    const quietHours = context.ownerFacts.quietHours;
    if (!quietHours) {
      return { kind: "allow" };
    }
    const start = parseHHMM(quietHours.start);
    const end = parseHHMM(quietHours.end);
    if (!start || !end) {
      return { kind: "allow" };
    }
    const local =
      localPartsAtTz(context.nowIso, quietHours.tz) ??
      localPartsForContext(context);
    const nowMinutes = local.hours * 60 + local.minutes;
    const startMinutes = start.hours * 60 + start.minutes;
    const endMinutes = end.hours * 60 + end.minutes;

    let inWindow: boolean;
    if (startMinutes <= endMinutes) {
      inWindow = nowMinutes >= startMinutes && nowMinutes < endMinutes;
    } else {
      // wraps midnight
      inWindow = nowMinutes >= startMinutes || nowMinutes < endMinutes;
    }
    if (!inWindow) {
      return { kind: "allow" };
    }
    // Defer to the next allowed window for low/medium tasks.
    const minutesUntilEnd =
      startMinutes <= endMinutes
        ? endMinutes - nowMinutes
        : nowMinutes >= startMinutes
          ? 24 * 60 - nowMinutes + endMinutes
          : endMinutes - nowMinutes;
    return {
      kind: "defer",
      until: { offsetMinutes: Math.max(1, minutesUntilEnd) },
      reason: `quiet_hours: deferring ${minutesUntilEnd}m until ${quietHours.end}`,
    };
  },
};

const duringTravelGate: TaskGateContribution = {
  kind: "during_travel",
  evaluate(_task, context): GateDecision {
    if (context.ownerFacts.travelActive === true) {
      return { kind: "allow" };
    }
    return { kind: "deny", reason: "during_travel: no active travel" };
  },
};

interface CircadianStateInParams {
  /** Circadian states the task may fire in. Default `["awake"]`. */
  states?: Array<"awake" | "asleep">;
}

/**
 * `circadian_state_in` — generic built-in fallback. The circadian state
 * (awake/asleep) is observed from the user's activity/health rhythm, which
 * lives in `plugin-personal-assistant`'s `ActivityProfile`. That reader is
 * registered by PA's runner wiring and, because `registerBuiltInGates` is
 * first-wins, takes precedence over this fallback.
 *
 * Standalone (no PA profile reader) there is no evidence the user is asleep, so
 * the honest default for the common `states: ["awake"]` packs is `allow`.
 * Packs that only want to fire while asleep get `deny`.
 */
const circadianStateInGate: TaskGateContribution = {
  kind: "circadian_state_in",
  evaluate(_task, context): GateDecision {
    const params = (context.task.shouldFire?.gates.find(
      (g) => g.kind === "circadian_state_in",
    )?.params ?? {}) as CircadianStateInParams;
    const states =
      Array.isArray(params.states) && params.states.length > 0
        ? params.states
        : (["awake"] as const);
    // No profile reader here → assume awake (no evidence of sleep).
    if (states.includes("awake")) {
      return { kind: "allow" };
    }
    return {
      kind: "deny",
      reason: `circadian_state_in: observed "awake" not in [${states.join(",")}]`,
    };
  },
};

interface NoRecentUserMessageInParams {
  /** Suppress when the user was active within this many minutes. Default 30. */
  minutes?: number;
}

/**
 * `no_recent_user_message_in` — real generic reader over the activity bus.
 * When a `message_activity_event` occurred within `params.minutes`, the user is
 * active, so the proactive poke is DEFERRED (delayed), not denied — dropping it
 * would silently lose the poke. Without a `lastSeenAt` heartbeat this built-in
 * can't know exactly when the user last spoke, so it delays by the full
 * suppression window. PA's runner wiring registers a richer reader that reads
 * `ActivityProfile.lastSeenAt` and defers by the precise remaining time;
 * first-wins keeps that one when present.
 */
const noRecentUserMessageInGate: TaskGateContribution = {
  kind: "no_recent_user_message_in",
  async evaluate(_task, context): Promise<GateDecision> {
    const params = (context.task.shouldFire?.gates.find(
      (g) => g.kind === "no_recent_user_message_in",
    )?.params ?? {}) as NoRecentUserMessageInParams;
    const minutes =
      typeof params.minutes === "number" &&
      Number.isFinite(params.minutes) &&
      params.minutes > 0
        ? params.minutes
        : 30;
    const nowMs = Date.parse(context.nowIso);
    if (!Number.isFinite(nowMs)) {
      return { kind: "allow" };
    }
    const sinceIso = new Date(nowMs - minutes * 60_000).toISOString();
    const active =
      (await context.activity.hasSignalSince({
        signalKind: "message_activity_event",
        sinceIso,
      })) === true;
    if (!active) {
      return { kind: "allow" };
    }
    return {
      kind: "defer",
      until: { offsetMinutes: minutes },
      reason: `no_recent_user_message_in: user active within ${minutes}m; deferring ${minutes}m`,
    };
  },
};

interface PersonalBaselineSufficientParams {
  minSamples?: number;
}

const personalBaselineSufficientGate: TaskGateContribution = {
  kind: "personal_baseline_sufficient",
  evaluate(_task, context): GateDecision {
    const params = (context.task.shouldFire?.gates.find(
      (g) => g.kind === "personal_baseline_sufficient",
    )?.params ?? {}) as PersonalBaselineSufficientParams;
    const minSamples = intInRange(params.minSamples ?? 1, 1, 10_000)
      ? (params.minSamples ?? 1)
      : 1;
    const sampleCount = context.ownerFacts.personalBaseline?.sampleCount;
    if (typeof sampleCount !== "number" || !Number.isFinite(sampleCount)) {
      return {
        kind: "deny",
        reason: "personal_baseline_sufficient: sample count unavailable",
      };
    }
    if (sampleCount >= minSamples) {
      return { kind: "allow" };
    }
    return {
      kind: "deny",
      reason: `personal_baseline_sufficient: sample count ${sampleCount} < ${minSamples}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface TaskGateRegistry {
  register(c: TaskGateContribution): void;
  get(kind: string): TaskGateContribution | null;
  list(): TaskGateContribution[];
}

export function createTaskGateRegistry(): TaskGateRegistry {
  const map = new Map<string, TaskGateContribution>();
  const reg: TaskGateRegistry = {
    register(c) {
      if (!c.kind || typeof c.kind !== "string") {
        throw new Error("TaskGateRegistry.register: kind required");
      }
      if (map.has(c.kind)) {
        // Last-writer-wins is intentionally NOT allowed: prevents silent
        // override. Callers should ensure no double-registration.
        throw new Error(
          `TaskGateRegistry.register: duplicate kind "${c.kind}"`,
        );
      }
      map.set(c.kind, c);
    },
    get(kind) {
      return map.get(kind) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
  };
  return reg;
}

/**
 * Register the built-in gates. First-wins: a caller (e.g. plugin-personal-
 * assistant's runner wiring) may register a richer, production reader for a
 * kind BEFORE this runs; the built-in is then skipped so the caller's reader
 * takes precedence. This is how `circadian_state_in` /
 * `no_recent_user_message_in` get their ActivityProfile-backed readers.
 */
export function registerBuiltInGates(reg: TaskGateRegistry): void {
  const builtins: TaskGateContribution[] = [
    weekendSkipGate,
    weekendOnlyGate,
    weekdayOnlyGate,
    lateEveningSkipGate,
    quietHoursGate,
    duringTravelGate,
    circadianStateInGate,
    noRecentUserMessageInGate,
    personalBaselineSufficientGate,
  ];
  for (const gate of builtins) {
    if (!reg.get(gate.kind)) {
      reg.register(gate);
    }
  }
}
