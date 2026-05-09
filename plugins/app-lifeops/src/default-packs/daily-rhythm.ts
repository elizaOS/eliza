/**
 * Default pack: `daily-rhythm`.
 *
 * Ships **enabled** out of the box (after the first-run wake-time question is
 * answered). Three records:
 *
 *   1. `gm` — gentle morning ping at the wake anchor. `priority: "low"`,
 *      `kind: "reminder"`, no escalation ladder (per wave1-interfaces.md §3.4
 *      `priority_low_default`).
 *   2. `gn` — bedtime ping at the bedtime anchor. `priority: "low"`.
 *   3. `daily-checkin` — `kind: "checkin"`, `priority: "medium"`, runs the
 *      morning-checkin assembly (delegated to `CheckinService.runMorningCheckin`
 *      via the morning-brief pack — see parity test). On no-reply the
 *      `pipeline.onSkip` fires a follow-up ping at +30 min, then `expired`.
 *
 * Closes GAP §2.4 (gm/gn starter + daily check-in).
 *
 * Stub status: see `contract-stubs.ts` — `ScheduledTask` types are local until
 * W1-A's `src/lifeops/scheduled-task/types.ts` lands.
 */

import type { ScheduledTaskSeed } from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export const DAILY_RHYTHM_PACK_KEY = "daily-rhythm";

/**
 * Record IDs are stable strings used as `idempotencyKey`s so re-running the
 * defaults pass is idempotent.
 */
export const DAILY_RHYTHM_RECORD_IDS = {
  gm: "default-pack:daily-rhythm:gm",
  gn: "default-pack:daily-rhythm:gn",
  checkin: "default-pack:daily-rhythm:morning-checkin",
  checkinFollowup: "default-pack:daily-rhythm:morning-checkin-followup",
} as const;

const gmRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a gentle good-morning to the owner. Acknowledge they are starting the day. Keep it short and warm; no questions, no checklist, no agenda.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
  },
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 0,
  },
  priority: "low",
  // Default low-priority ladder applies (no retry).
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: DAILY_RHYTHM_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: DAILY_RHYTHM_RECORD_IDS.gm,
  metadata: {
    packKey: DAILY_RHYTHM_PACK_KEY,
    recordKey: "gm",
  },
};

const gnRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a gentle good-night to the owner near their bedtime. One sentence; warm, no agenda, no questions, no recap.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "eveningWindow", "timezone"],
  },
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "bedtime.target",
    offsetMinutes: 0,
  },
  priority: "low",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: DAILY_RHYTHM_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: DAILY_RHYTHM_RECORD_IDS.gn,
  metadata: {
    packKey: DAILY_RHYTHM_PACK_KEY,
    recordKey: "gn",
  },
};

/**
 * Followup record fired by `pipeline.onSkip` if the owner does not reply to
 * the daily check-in within the `user_replied_within` window. After this
 * fires, the parent task transitions to `expired` per §8.10.
 */
const checkinFollowupRecord: ScheduledTaskSeed = {
  kind: "followup",
  promptInstructions:
    "The owner did not respond to the morning check-in. Send one short follow-up nudge — no recap, no list. Acknowledge they may be busy and leave the door open.",
  contextRequest: {
    includeOwnerFacts: ["preferredName"],
    includeRecentTaskStates: { kind: "checkin", lookbackHours: 24 },
  },
  // The parent's `pipeline.onSkip` fires this 30 minutes after the parent skips.
  trigger: { kind: "manual" },
  priority: "low",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: DAILY_RHYTHM_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: DAILY_RHYTHM_RECORD_IDS.checkinFollowup,
  metadata: {
    packKey: DAILY_RHYTHM_PACK_KEY,
    recordKey: "checkin-followup",
    pipelineRole: "onSkip",
  },
};

const checkinRecord: ScheduledTaskSeed = {
  kind: "checkin",
  promptInstructions:
    "Run the morning check-in for the owner. Use the assembled briefing (overdue todos, today's meetings, yesterday's wins, tracked habits, inbox/calendar/contacts/promises sections) to deliver one concise start-of-day message. Ask one open question at the end so the owner can reply.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
    includeRecentTaskStates: { kind: "checkin", lookbackHours: 48 },
  },
  // 30 minutes after wake.confirmed. Wave-2 may move this onto a separate
  // anchor; for Wave-1 we ride the same wake anchor with an offset.
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 30,
  },
  priority: "medium",
  completionCheck: {
    kind: "user_replied_within",
    params: { lookbackMinutes: 60 },
  },
  pipeline: {
    onSkip: [checkinFollowupRecord],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: DAILY_RHYTHM_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: DAILY_RHYTHM_RECORD_IDS.checkin,
  metadata: {
    packKey: DAILY_RHYTHM_PACK_KEY,
    recordKey: "checkin",
    // The `morning-brief` pack assembles content; this record runs the
    // CheckinService and uses `summaryText` as `promptInstructions` for the
    // user-visible message. Parity with `CheckinService.runMorningCheckin`
    // is asserted by `test/default-pack-morning-brief.parity.test.ts`.
    delegatesAssemblyTo: "lifeops:checkin:morning",
  },
};

export const dailyRhythmPack: DefaultPack = {
  key: DAILY_RHYTHM_PACK_KEY,
  label: "Daily rhythm",
  description:
    "A gentle morning hello, an evening goodnight, and one start-of-day check-in. Three records — the agent's heartbeat.",
  defaultEnabled: true,
  records: [gmRecord, gnRecord, checkinRecord],
  uiHints: {
    summaryOnDayOne:
      "gm at wake, daily check-in 30 min later, gn at bedtime — three messages.",
    expectedFireCountPerDay: 3,
  },
};
