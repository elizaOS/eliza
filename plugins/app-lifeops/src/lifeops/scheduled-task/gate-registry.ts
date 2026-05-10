/**
 * TaskGateRegistry. Built-in kinds: `weekend_skip`, `weekend_only`,
 * `weekday_only`, `late_evening_skip`, `quiet_hours`, `during_travel`.
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
      else if (part.type === "minute") minutes = Number.parseInt(part.value, 10);
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

const weekdayOnlyGate: TaskGateContribution = {
  kind: "weekday_only",
  evaluate(_task, context): GateDecision {
    const { dayOfWeek } = localPartsForContext(context);
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
    const local = localPartsAtTz(context.nowIso, quietHours.tz) ??
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

export function registerBuiltInGates(reg: TaskGateRegistry): void {
  reg.register(weekendSkipGate);
  reg.register(weekendOnlyGate);
  reg.register(weekdayOnlyGate);
  reg.register(lateEveningSkipGate);
  reg.register(quietHoursGate);
  reg.register(duringTravelGate);
}
