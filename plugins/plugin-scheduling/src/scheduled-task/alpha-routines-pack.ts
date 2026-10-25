/**
 * Alpha routines default-task pack (#31022).
 *
 * Three owner-facing routines for the Alpha phone project — a morning brief, a
 * reminders digest, and an evening nudge — seeded through the generic seed
 * registry exactly once per idempotency key. Every routine ships DISABLED: a
 * `manual` trigger is never due on a tick (`isScheduledTaskDue` returns
 * `manual`), so nothing fires until the owner enables it. Enabling is an
 * ordinary `edit` that swaps in `metadata.enableTrigger`, a cron in the
 * owner's timezone (`owner_local`, resolved from owner facts at due-time).
 *
 * The pack is opt-in per runtime via the `ELIZA_SCHEDULING_DEFAULT_PACKS`
 * setting and registers as a `supplemental` pack, so it seeds alongside either
 * the built-in fallback pack (no consumer host) or a consumer host's pack
 * (e.g. `@elizaos/plugin-personal-assistant`) without suppressing or being
 * suppressed by them.
 */

import type { DefaultTaskPack } from "./seed-registry.js";
import { OWNER_LOCAL_TZ } from "./trigger-tz.js";
import type { ScheduledTaskInput, ScheduledTaskTrigger } from "./types.js";

/** Stable pack id; also the value that opts a runtime into this pack. */
export const ALPHA_ROUTINES_PACK_ID = "alpha-routines";

/** Setting listing the opt-in default packs (comma-separated pack ids). */
export const SCHEDULING_DEFAULT_PACKS_SETTING =
  "ELIZA_SCHEDULING_DEFAULT_PACKS";

export const ALPHA_ROUTINES_IDEMPOTENCY_KEYS = {
  morningBrief: "scheduling:alpha:morning-brief",
  reminders: "scheduling:alpha:reminders",
  nudge: "scheduling:alpha:nudge",
} as const;

type CronTrigger = Extract<ScheduledTaskTrigger, { kind: "cron" }>;

function ownerLocalDaily(hour: number): CronTrigger {
  return { kind: "cron", expression: `0 ${hour} * * *`, tz: OWNER_LOCAL_TZ };
}

/** The schedule each routine adopts when the owner enables it. */
export const ALPHA_ROUTINES_ENABLE_TRIGGERS = {
  morningBrief: ownerLocalDaily(8),
  reminders: ownerLocalDaily(12),
  nudge: ownerLocalDaily(18),
} as const satisfies Record<
  keyof typeof ALPHA_ROUTINES_IDEMPOTENCY_KEYS,
  CronTrigger
>;

/** Parse the opt-in setting into pack ids (trimmed, empty entries dropped). */
export function parseDefaultPackSetting(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function buildAlphaRoutinesPack(opts: {
  agentId: string;
}): DefaultTaskPack {
  const { agentId } = opts;
  const routine = (
    args: Pick<
      ScheduledTaskInput,
      "kind" | "promptInstructions" | "priority" | "contextRequest"
    > & {
      key: keyof typeof ALPHA_ROUTINES_IDEMPOTENCY_KEYS;
      recordKey: string;
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
    idempotencyKey: ALPHA_ROUTINES_IDEMPOTENCY_KEYS[args.key],
    output: { destination: "channel", target: "in_app" },
    metadata: {
      defaultPack: ALPHA_ROUTINES_PACK_ID,
      recordKey: args.recordKey,
      slot: args.slot,
      pausedByDefault: true,
      enableTrigger: { ...ALPHA_ROUTINES_ENABLE_TRIGGERS[args.key] },
    },
  });

  return {
    id: ALPHA_ROUTINES_PACK_ID,
    supplemental: true,
    tasks: [
      routine({
        key: "morningBrief",
        recordKey: "alpha-morning-brief",
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
        recordKey: "alpha-reminders",
        slot: "Reminders",
        kind: "reminder",
        priority: "medium",
        promptInstructions:
          "Remind the owner of the reminders and commitments due for the rest of today, most time-sensitive first. If nothing is due, say so in one short line.",
        contextRequest: { includeOwnerFacts: ["preferredName", "timezone"] },
      }),
      routine({
        key: "nudge",
        recordKey: "alpha-nudge",
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
