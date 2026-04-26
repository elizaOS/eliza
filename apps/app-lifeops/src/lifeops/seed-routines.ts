/**
 * Seed routine templates offered during first-run onboarding.
 *
 * These are data-only definitions — no hardcoded logic is tied to any
 * specific routine.  The seeding flow creates standard task definitions
 * through the normal LifeOps service API so they benefit from the same
 * adaptive timing, reminders, and escalation as user-created tasks.
 */

import type { CreateLifeOpsDefinitionRequest } from "../contracts/index.js";

export interface RoutineSeedTemplate {
  /** Stable key used to deduplicate across seeding offers. */
  key: string;
  title: string;
  description: string;
  category: "hygiene" | "health" | "fitness" | "nutrition";
  /** Partial request — the caller supplies agent/domain/tz fields. */
  request: Pick<
    CreateLifeOpsDefinitionRequest,
    "kind" | "title" | "cadence" | "priority" | "originalIntent"
  >;
}

export const ROUTINE_SEED_TEMPLATES: RoutineSeedTemplate[] = [
  {
    key: "brush_teeth",
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
    key: "invisalign",
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
    key: "drink_water",
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
    key: "stretch",
    title: "Stretch",
    description: "Short stretch breaks in the afternoon and evening",
    category: "health",
    request: {
      kind: "habit",
      title: "Stretch",
      cadence: {
        kind: "interval",
        everyMinutes: 360,
        windows: ["afternoon", "evening"],
        maxOccurrencesPerDay: 2,
      },
      priority: 2,
      originalIntent: "stretch twice daily in the afternoon and evening",
    },
  },
  {
    key: "vitamins",
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
    key: "workout",
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
    key: "shower",
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
    key: "shave",
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
