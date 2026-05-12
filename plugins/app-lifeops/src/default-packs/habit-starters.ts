/**
 * Default pack: `habit-starters` — 8 habits, **offered** at first-run
 * customize, not auto-seeded.
 *
 * The 8 habits are derived directly from the existing
 * `src/lifeops/seed-routines.ts` (which `IMPLEMENTATION_PLAN.md` §3.4 says
 * becomes a transitional alias importing from this file). The casts:
 *
 *   1. brush teeth — twice daily
 *   2. shower — 3×/week
 *   3. invisalign — lunchtime weekday
 *   4. drink water — interval
 *   5. stretch — interval + multi-gate (`first_deny`: weekend_skip,
 *      late_evening_skip, stretch.walk_out_reset) per IMPL §3.4 + §3.6 of GAP
 *   6. vitamins — with-meal trigger
 *   7. workout — afternoon, with workout-blocker pipeline placeholder for W2-F
 *   8. shave — weekly
 *
 * `defaultEnabled: false` — first-run customize asks; defaults path skips.
 *
 * Stub status: see `contract-stubs.ts` — `ScheduledTask` types local until
 * W1-A's `src/lifeops/scheduled-task/types.ts` lands.
 */

import type { ScheduledTaskSeed } from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export const HABIT_STARTERS_PACK_KEY = "habit-starters";

export const HABIT_STARTER_KEYS = {
  brushTeeth: "brush_teeth",
  shower: "shower",
  invisalign: "invisalign",
  drinkWater: "drink_water",
  stretch: "stretch",
  vitamins: "vitamins",
  workout: "workout",
  shave: "shave",
} as const;

const recordIdFor = (key: string) => `default-pack:habit-starters:${key}`;

/** Brush teeth — twice daily, morning + night windows. */
const brushTeethRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a short brush-teeth reminder. Acknowledge the time-of-day (morning vs night) without restating it as a fact.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "during_window", windowKey: "morning_or_night" },
  priority: "medium",
  shouldFire: { gates: [] },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.brushTeeth),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.brushTeeth,
    cadence: "daily_twice",
    legacyCategory: "hygiene",
  },
};

/** Shower — 3×/week (Mon/Wed/Fri morning). */
const showerRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a short shower reminder for the user's scheduled shower day. No medical framing; matter-of-fact.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "during_window", windowKey: "morning" },
  priority: "low",
  shouldFire: {
    gates: [{ kind: "weekday_only", params: { weekdays: [1, 3, 5] } }],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.shower),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.shower,
    cadence: "weekly_three_times",
    legacyCategory: "hygiene",
  },
};

/** Invisalign — weekday after lunch. */
const invisalignRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a short Invisalign tray-check reminder after lunch on a weekday. Tone: routine, not nagging.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "during_window", windowKey: "afternoon" },
  priority: "medium",
  shouldFire: {
    gates: [{ kind: "weekday_only", params: { weekdays: [1, 2, 3, 4, 5] } }],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.invisalign),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.invisalign,
    cadence: "weekday_lunch",
    legacyCategory: "health",
  },
};

/** Drink water — interval, morning/afternoon/evening windows, max 4/day. */
const drinkWaterRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a short hydration reminder. Vary phrasing across the day. No alarm; light touch.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "interval", everyMinutes: 120 },
  priority: "low",
  shouldFire: {
    gates: [
      {
        kind: "during_window",
        params: { windows: ["morning", "afternoon", "evening"] },
      },
    ],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.drinkWater),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.drinkWater,
    cadence: "interval_120m",
    maxOccurrencesPerDay: 4,
    legacyCategory: "health",
  },
};

/**
 * Stretch — interval + multi-gate composition (per IMPL §3.4):
 *   `first_deny`: [weekend_skip, late_evening_skip, stretch.walk_out_reset]
 *
 * `first_deny` short-circuits on the first denying gate; the registered
 * `stretch.walk_out_reset` gate from W1-A's `gate-registry.ts` is the
 * replacement for the legacy `stretch-decider.ts` walk-out reset (per
 * GAP §2.7).
 */
const stretchRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a soft stretch nudge for the user. One sentence; no sets, no counts. Pure invitation.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "interval", everyMinutes: 360 },
  priority: "low",
  shouldFire: {
    compose: "first_deny",
    gates: [
      { kind: "weekend_skip" },
      { kind: "late_evening_skip" },
      { kind: "stretch.walk_out_reset" },
    ],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.stretch),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.stretch,
    cadence: "interval_360m",
    maxOccurrencesPerDay: 2,
    legacyCategory: "health",
    activityGate: "active_on_computer",
  },
};

/** Vitamins — with-meal trigger (morning + evening windows). */
const vitaminsRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a short vitamins reminder near a meal window. No medical framing.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "during_window", windowKey: "morning_or_evening" },
  priority: "medium",
  shouldFire: { gates: [] },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.vitamins),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.vitamins,
    cadence: "with_meals",
    legacyCategory: "nutrition",
  },
};

/**
 * Workout — afternoon, with workout-blocker pipeline placeholder for W2-F
 * (BlockerRegistry). Wave-1 keeps the pipeline empty; Wave-2 will inject the
 * "release block on completion" follow-up.
 */
const workoutRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a workout reminder for the afternoon. Direct, not pleading; one short sentence. Recent reminder outcomes are in context — let them shape tone (e.g. softer after a skip streak) without restating the streak as a fact.",
  contextRequest: {
    includeOwnerFacts: ["preferredName"],
    includeRecentTaskStates: {
      kind: "reminder",
      lookbackHours: 24 * 7,
    },
  },
  trigger: { kind: "during_window", windowKey: "afternoon" },
  priority: "high",
  shouldFire: { gates: [] },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.workout),
  pipeline: {
    // Placeholder: W2-F's BlockerRegistry will register the "workout-blocker
    // release on completion" pipeline child. Wave-1 ships an empty array so
    // the field is always present and W2-F can populate without schema churn.
    onComplete: [],
  },
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.workout,
    cadence: "daily_afternoon",
    legacyCategory: "fitness",
    workoutBlockerPlaceholder: true,
  },
};

/** Shave — weekly (Tue/Fri morning). */
const shaveRecord: ScheduledTaskSeed = {
  kind: "reminder",
  promptInstructions:
    "Send a short shave reminder on a scheduled morning. Tone: routine.",
  contextRequest: { includeOwnerFacts: ["preferredName"] },
  trigger: { kind: "during_window", windowKey: "morning" },
  priority: "low",
  shouldFire: {
    gates: [{ kind: "weekday_only", params: { weekdays: [2, 5] } }],
  },
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: HABIT_STARTERS_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: recordIdFor(HABIT_STARTER_KEYS.shave),
  metadata: {
    packKey: HABIT_STARTERS_PACK_KEY,
    recordKey: HABIT_STARTER_KEYS.shave,
    cadence: "weekly_twice",
    legacyCategory: "hygiene",
  },
};

export const HABIT_STARTER_RECORDS: ReadonlyArray<ScheduledTaskSeed> = [
  brushTeethRecord,
  showerRecord,
  invisalignRecord,
  drinkWaterRecord,
  stretchRecord,
  vitaminsRecord,
  workoutRecord,
  shaveRecord,
];

export const habitStartersPack: DefaultPack = {
  key: HABIT_STARTERS_PACK_KEY,
  label: "Habit starters",
  description:
    "Eight starter habits offered at first-run customize: brush teeth, shower, invisalign, drink water, stretch, vitamins, workout, shave. Not auto-seeded — the user picks which to enable.",
  defaultEnabled: false,
  records: [...HABIT_STARTER_RECORDS],
  uiHints: {
    summaryOnDayOne:
      "Eight habit options offered at customize; nothing seeded automatically.",
    expectedFireCountPerDay: 0,
  },
};

/**
 * Generates the seeding offer message at runtime from the pack metadata —
 * removes the previous hardcoded SEEDING_MESSAGE in
 * `proactive-worker.ts:581-585` (per IMPL §3.4 owned-files-modified note).
 */
export function buildSeedingOfferMessage(): string {
  const titleByKey: Record<string, string> = {
    [HABIT_STARTER_KEYS.brushTeeth]: "brush teeth",
    [HABIT_STARTER_KEYS.shower]: "shower",
    [HABIT_STARTER_KEYS.invisalign]: "invisalign",
    [HABIT_STARTER_KEYS.drinkWater]: "drink water",
    [HABIT_STARTER_KEYS.stretch]: "stretch breaks",
    [HABIT_STARTER_KEYS.vitamins]: "vitamins",
    [HABIT_STARTER_KEYS.workout]: "workout",
    [HABIT_STARTER_KEYS.shave]: "shave",
  };
  const labels = HABIT_STARTER_RECORDS.map((record) => {
    const recordKey = (record.metadata?.recordKey as string | undefined) ?? "";
    return titleByKey[recordKey] ?? recordKey;
  }).filter(Boolean);
  const list = labels.join(", ");
  return [
    "I notice you haven't set up any routines yet.",
    "Want me to set up some foundational habits?",
    `I can add: ${list} reminders.`,
    "Say 'set up my routines' or pick and choose.",
  ].join(" ");
}
