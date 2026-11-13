/** Reusable morning, reminder and evening routines; no product is selected implicitly. */
import type { DefaultTaskPack } from "./seed-registry.js";
import { OWNER_LOCAL_TZ } from "./trigger-tz.js";
import type { ScheduledTaskInput, ScheduledTaskTrigger } from "./types.js";

/** Consumer-owned identifiers; preserve installed values when adopting this builder. */
export interface DailyRoutineKeys {
  morningBrief: string;
  reminders: string;
  nudge: string;
}

type CronTrigger = Extract<ScheduledTaskTrigger, { kind: "cron" }>;

function ownerLocalDaily(hour: number): CronTrigger {
  return { kind: "cron", expression: `0 ${hour} * * *`, tz: OWNER_LOCAL_TZ };
}

/** The schedule each routine adopts when the owner enables it. */
export const DAILY_ROUTINES_ENABLE_TRIGGERS = {
  morningBrief: ownerLocalDaily(8),
  reminders: ownerLocalDaily(12),
  nudge: ownerLocalDaily(18),
} as const satisfies Record<keyof DailyRoutineKeys, CronTrigger>;

/** Build disabled routines; a consumer registers the result with registerDefaultTaskPack. */
export function buildDailyRoutinesPack(opts: {
  agentId: string;
  packId: string;
  idempotencyKeys: DailyRoutineKeys;
  recordKeys: DailyRoutineKeys;
}): DefaultTaskPack {
  const { agentId } = opts;
  const routine = (
    args: Pick<
      ScheduledTaskInput,
      "kind" | "promptInstructions" | "priority" | "contextRequest"
    > & {
      key: keyof DailyRoutineKeys;
      slot: string;
    },
  ): ScheduledTaskInput => ({
    kind: args.kind,
    promptInstructions: args.promptInstructions,
    ...(args.contextRequest ? { contextRequest: args.contextRequest } : {}),
    trigger: { kind: "manual" },
    priority: args.priority,
    respectsGlobalPause: true,
    source: "default_pack",
    createdBy: agentId,
    ownerVisible: true,
    idempotencyKey: opts.idempotencyKeys[args.key],
    output: { destination: "channel", target: "in_app" },
    metadata: {
      defaultPack: opts.packId,
      recordKey: opts.recordKeys[args.key],
      slot: args.slot,
      pausedByDefault: true,
      enableTrigger: { ...DAILY_ROUTINES_ENABLE_TRIGGERS[args.key] },
    },
  });

  return {
    id: opts.packId,
    supplemental: true,
    tasks: [
      routine({
        key: "morningBrief",
        slot: "Morning brief",
        kind: "recap",
        priority: "medium",
        promptInstructions:
          "Give the owner a short morning brief: today's meetings, overdue or due-today todos, and anything that needs a reply. Keep it concise. No invented facts; if a source is unavailable, say so in one clause.",
        contextRequest: {
          includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
        },
      }),
      routine({
        key: "reminders",
        slot: "Reminders",
        kind: "reminder",
        priority: "medium",
        promptInstructions:
          "Remind the owner of the reminders and commitments due for the rest of today, most time-sensitive first. If nothing is due, say so in one short line.",
        contextRequest: { includeOwnerFacts: ["preferredName", "timezone"] },
      }),
      routine({
        key: "nudge",
        slot: "Nudge",
        kind: "checkin",
        priority: "low",
        promptInstructions:
          "Send the owner one gentle, low-pressure nudge about the most important open item from today, and ask whether they want help with it.",
        contextRequest: {
          includeOwnerFacts: ["preferredName", "timezone"],
          includeRecentTaskStates: { lookbackHours: 24 },
        },
      }),
    ],
  };
}
