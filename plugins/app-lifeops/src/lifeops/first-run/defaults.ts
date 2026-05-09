/**
 * Defaults-path spec for first-run.
 *
 * **One question only:** "what time do you usually wake up?" The answer is
 * parsed into an `OwnerFactWindow` (start = the wake time; end = wake + 5h)
 * and persisted as `morningWindow` on `OwnerFactStore`. After that the
 * defaults pack is materialized as a set of `ScheduledTask` records and
 * scheduled through the `ScheduledTaskRunner`.
 *
 * Pack contents (all `respectsGlobalPause: true` so vacation mode pauses
 * them; `source: "first_run"`):
 *   - **gm reminder** — fires at the start of `morningWindow` daily; low
 *     priority; no completion check.
 *   - **gn reminder** — fires at 22:00 local daily; low priority.
 *   - **daily check-in** — `kind: "checkin"`, `priority: "medium"`, fires
 *     at 09:00 local; `completionCheck.kind = "user_replied_within"`.
 *   - **morning brief stub** — `kind: "watcher"` triggered on the
 *     `wake.confirmed` anchor; `priority: "medium"`. The actual brief
 *     assembler is W1-D's morning-brief default pack — this entry is the
 *     shim that signals "the user opted into a morning brief" so the W1-D
 *     pack does not double-schedule.
 *
 * Per the wave-1 boundary, this module emits the spec; the action calls
 * `ScheduledTaskRunner.schedule` for each entry. When W1-A's runner is not
 * yet wired in (e.g. during integration tests), the action falls back to
 * an in-memory recorder so the contract remains testable.
 */

import type {
  ScheduledTaskInput,
  ScheduledTaskTrigger,
} from "../wave1-types.js";
import type { OwnerFactWindow } from "./state.js";

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const HOUR_OF_DAY_PATTERN = /^(?:[01]?\d|2[0-3])$/;

/**
 * Parse free-text wake time into an HH:MM string. Accepts "6", "06:00",
 * "6:30am", "5:45 am", "noon", etc. Returns null if no plausible parse.
 */
export function parseWakeTime(input: string): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  if (raw === "noon" || raw === "midday") return "12:00";
  if (raw === "midnight") return "00:00";

  // Already HH:MM 24h?
  if (TIME_OF_DAY_PATTERN.test(raw)) {
    return raw;
  }

  // Match `H[:MM][am|pm]` with optional whitespace.
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/u);
  if (!match) return null;

  let hours = Number.parseInt(match[1], 10);
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.replace(/\./g, "");

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (minutes < 0 || minutes >= 60) return null;

  if (meridiem === "am" || meridiem === "pm") {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "am") {
      hours = hours === 12 ? 0 : hours;
    } else {
      hours = hours === 12 ? 12 : hours + 12;
    }
  } else {
    if (!HOUR_OF_DAY_PATTERN.test(String(hours))) return null;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Derive a five-hour morning window from the wake time. End is clamped to
 * 23:59 if the wake time is so late that +5h would wrap.
 */
export function deriveMorningWindow(wakeHHMM: string): OwnerFactWindow {
  if (!TIME_OF_DAY_PATTERN.test(wakeHHMM)) {
    throw new Error(`[first-run defaults] invalid wake time: ${wakeHHMM}`);
  }
  const [hStr, mStr] = wakeHHMM.split(":");
  const startHours = Number.parseInt(hStr, 10);
  const startMinutes = Number.parseInt(mStr, 10);
  const totalMinutes = startHours * 60 + startMinutes;
  const endTotalMinutes = Math.min(totalMinutes + 5 * 60, 23 * 60 + 59);
  const endHours = Math.floor(endTotalMinutes / 60);
  const endMinutes = endTotalMinutes % 60;
  return {
    startLocal: wakeHHMM,
    endLocal: `${String(endHours).padStart(2, "0")}:${String(endMinutes).padStart(2, "0")}`,
  };
}

export interface DefaultsPackContext {
  morningWindow: OwnerFactWindow;
  timezone: string;
  agentId: string;
  channel?: string;
}

/**
 * Stable idempotency keys. Replay (per `GAP_ASSESSMENT.md` §8.14) keeps
 * existing tasks intact; the runner is expected to upsert by idempotencyKey
 * if the same key is presented twice.
 */
export const DEFAULT_PACK_IDEMPOTENCY_KEYS = {
  gm: "lifeops:first-run:default:gm",
  gn: "lifeops:first-run:default:gn",
  checkin: "lifeops:first-run:default:checkin",
  morningBrief: "lifeops:first-run:default:morning-brief",
} as const;

function cronAtLocal(hhmm: string, tz: string): ScheduledTaskTrigger {
  const [h, m] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
  return {
    kind: "cron",
    expression: `${m} ${h} * * *`,
    tz,
  };
}

export function buildDefaultsPack(
  context: DefaultsPackContext,
): ScheduledTaskInput[] {
  const { morningWindow, timezone, agentId } = context;
  const channel = context.channel ?? "in_app";
  return [
    {
      kind: "reminder",
      promptInstructions:
        "Wish the owner a warm good morning and surface anything pressing for the day.",
      trigger: cronAtLocal(morningWindow.startLocal, timezone),
      priority: "low",
      respectsGlobalPause: true,
      source: "first_run",
      createdBy: agentId,
      ownerVisible: true,
      idempotencyKey: DEFAULT_PACK_IDEMPOTENCY_KEYS.gm,
      output: { destination: "channel", target: channel },
      contextRequest: {
        includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
      },
      metadata: {
        firstRunPack: "defaults",
        slot: "gm",
      },
    },
    {
      kind: "reminder",
      promptInstructions: "Wish the owner good night before they wind down.",
      trigger: cronAtLocal("22:00", timezone),
      priority: "low",
      respectsGlobalPause: true,
      source: "first_run",
      createdBy: agentId,
      ownerVisible: true,
      idempotencyKey: DEFAULT_PACK_IDEMPOTENCY_KEYS.gn,
      output: { destination: "channel", target: channel },
      contextRequest: {
        includeOwnerFacts: ["preferredName", "eveningWindow", "timezone"],
      },
      metadata: {
        firstRunPack: "defaults",
        slot: "gn",
      },
    },
    {
      kind: "checkin",
      promptInstructions:
        "Run the daily check-in: ask the owner how they're feeling and what's on their plate today.",
      trigger: cronAtLocal("09:00", timezone),
      priority: "medium",
      respectsGlobalPause: true,
      source: "first_run",
      createdBy: agentId,
      ownerVisible: true,
      idempotencyKey: DEFAULT_PACK_IDEMPOTENCY_KEYS.checkin,
      completionCheck: {
        kind: "user_replied_within",
        params: { lookbackMinutes: 60 },
        followupAfterMinutes: 30,
      },
      output: { destination: "channel", target: channel },
      contextRequest: {
        includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
        includeRecentTaskStates: { kind: "checkin", lookbackHours: 48 },
      },
      metadata: {
        firstRunPack: "defaults",
        slot: "checkin",
      },
    },
    {
      kind: "watcher",
      promptInstructions:
        "Render the morning brief at the wake.confirmed anchor.",
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 0,
      },
      priority: "medium",
      respectsGlobalPause: true,
      source: "first_run",
      createdBy: agentId,
      ownerVisible: true,
      idempotencyKey: DEFAULT_PACK_IDEMPOTENCY_KEYS.morningBrief,
      output: { destination: "channel", target: channel },
      contextRequest: {
        includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
      },
      metadata: {
        firstRunPack: "defaults",
        slot: "morningBrief",
      },
    },
  ];
}
