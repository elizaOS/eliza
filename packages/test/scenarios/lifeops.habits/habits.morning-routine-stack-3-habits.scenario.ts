/**
 * Habits: morning routine stack of 3 habits — distinct from
 * habit.morning-routine.full-stack which sets 4 habits. This is a tighter
 * "brush + water + meditate" trio.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "habits.morning-routine-stack-3-habits",
  title: "Morning routine stack: brush, water, meditate",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "multi-action", "morning"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Morning 3-Stack",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning 3-stack preview",
      text: "Set up a quick morning routine: brush teeth, drink a big glass of water, and meditate for 5 minutes.",
      // Derived schedule: the user gave no time, so any concrete morning
      // clock time in the preview is computed, not echoed ("three" cannot
      // anchor this file — it appears in the confirm turn's text).
      responseIncludesAny: [" am", ":00", ":30"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose three distinct morning habits (brush teeth, glass of water, 5-minute meditation) anchored to a concrete morning time and ask the owner to confirm before saving. Claiming they are already saved fails.",
      },
    },
    {
      kind: "message",
      name: "morning 3-stack confirm",
      text: "Yes, save all three as morning habits.",
      // Save-confirmation semantics in words the prompt never used ("set
      // up" is omitted because the preview prompt itself says "Set up").
      responseIncludesAny: ["saved", "created", "scheduled", "added", "recorded"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Morning brush teeth"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Morning water", "Glass of water"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Meditate",
      titleAliases: ["Morning meditation", "5-minute meditation"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
