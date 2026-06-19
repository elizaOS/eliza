/**
 * Seed routine templates offered during first-run onboarding.
 *
 * Canonical source of truth for habit starters: `src/default-packs/habit-starters.ts`.
 * Do not add new templates here — author them there instead.
 */

import type { CreateLifeOpsDefinitionRequest } from "../contracts/index.js";
import { HABIT_STARTER_KEYS } from "../default-packs/habit-starters.js";
import {
  REMINDER_ACTIVITY_GATE_METADATA_KEY,
  REMINDER_URGENCY_METADATA_KEY,
} from "./service-constants.js";

/**
 * Canonical title for the seeded stretch routine. Exported so the
 * reminder dispatch loop can apply stretch-specific gating without
 * grep-matching string literals.
 */
export const STRETCH_ROUTINE_TITLE = "Stretch";

export interface RoutineSeedTemplate {
  /** Stable key used to deduplicate across seeding offers. */
  key: string;
  title: string;
  description: string;
  category: "hygiene" | "health" | "fitness" | "nutrition";
  /** Partial request — the caller supplies agent/domain/tz fields. */
  request: Pick<
    CreateLifeOpsDefinitionRequest,
    "kind" | "title" | "cadence" | "priority" | "originalIntent" | "metadata"
  >;
}

export const ROUTINE_SEED_TEMPLATES: RoutineSeedTemplate[] = [
  {
    key: HABIT_STARTER_KEYS.brushTeeth,
    title: "Brush teeth",
    description: "Morning and night tooth brushing",
    category: "hygiene",
    request: {
      kind: "routine",
      title: "Brush teeth",
      cadence: { kind: "daily", windows: ["morning", "night"] },
      priority: 4,
      originalIntent: "brush teeth morning and night",
    },
  },
  {
    key: HABIT_STARTER_KEYS.invisalign,
    title: "Invisalign",
    description: "Weekday after-lunch tray check",
    category: "health",
    request: {
      kind: "habit",
      title: "Invisalign",
      cadence: {
        kind: "weekly",
        weekdays: [1, 2, 3, 4, 5],
        windows: ["afternoon"],
      },
      priority: 3,
      originalIntent: "weekday after-lunch Invisalign check",
    },
  },
  {
    key: HABIT_STARTER_KEYS.drinkWater,
    title: "Drink water",
    description: "Stay hydrated throughout the day",
    category: "health",
    request: {
      kind: "habit",
      title: "Drink water",
      cadence: {
        kind: "interval",
        everyMinutes: 120,
        windows: ["morning", "afternoon", "evening"],
        maxOccurrencesPerDay: 4,
      },
      priority: 3,
      originalIntent: "drink water regularly throughout the day",
    },
  },
  {
    key: HABIT_STARTER_KEYS.stretch,
    title: STRETCH_ROUTINE_TITLE,
    description: "Soft stretch nudges in the afternoon and evening",
    category: "health",
    request: {
      kind: "habit",
      title: STRETCH_ROUTINE_TITLE,
      cadence: {
        kind: "interval",
        everyMinutes: 360,
        windows: ["afternoon", "evening"],
        maxOccurrencesPerDay: 2,
      },
      priority: 2,
      originalIntent:
        "soft stretch reminder twice daily in the afternoon and evening",
      // Stretch is a soft self-care nudge — never escalate aggressively.
      // The high-urgency cadence (7m initial / 10m repeat across SMS, voice,
      // Discord) is appropriate for medication or workout-block reminders,
      // not stretch breaks. Demoted to "medium" so an unacknowledged stretch
      // reminder retries at 90m / 180m via softer channels only.
      metadata: {
        [REMINDER_ACTIVITY_GATE_METADATA_KEY]: "active_on_computer",
        [REMINDER_URGENCY_METADATA_KEY]: "medium",
      },
    },
  },
  {
    key: HABIT_STARTER_KEYS.vitamins,
    title: "Take vitamins",
    description: "Vitamins with meals",
    category: "nutrition",
    request: {
      kind: "routine",
      title: "Take vitamins",
      cadence: { kind: "daily", windows: ["morning", "evening"] },
      priority: 3,
      originalIntent: "take vitamins with breakfast and dinner",
    },
  },
  {
    key: HABIT_STARTER_KEYS.workout,
    title: "Workout",
    description: "Daily exercise session",
    category: "fitness",
    request: {
      kind: "habit",
      title: "Workout",
      cadence: { kind: "daily", windows: ["afternoon"] },
      priority: 4,
      originalIntent: "daily afternoon workout",
    },
  },
  {
    key: HABIT_STARTER_KEYS.shower,
    title: "Shower",
    description: "Regular showers",
    category: "hygiene",
    request: {
      kind: "routine",
      title: "Shower",
      cadence: { kind: "weekly", weekdays: [1, 3, 5], windows: ["morning"] },
      priority: 3,
      originalIntent: "shower three times per week",
    },
  },
  {
    key: HABIT_STARTER_KEYS.shave,
    title: "Shave",
    description: "Regular shaving",
    category: "hygiene",
    request: {
      kind: "routine",
      title: "Shave",
      cadence: { kind: "weekly", weekdays: [2, 5], windows: ["morning"] },
      priority: 2,
      originalIntent: "shave twice per week",
    },
  },
];
