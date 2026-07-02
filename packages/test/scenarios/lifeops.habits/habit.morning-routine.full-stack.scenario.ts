/**
 * Multi-habit creation in a single turn: full morning routine covering
 * brush teeth, stretch, water, and vitamins. Verifies the agent can
 * create multiple habit definitions from one natural-language request.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "habit.morning-routine.full-stack",
  title: "Set up a full morning routine in one request",
  domain: "habits",
  tags: ["lifeops", "habits", "multi-action", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Morning Routine",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "morning-routine preview",
      text: "Set up my morning routine: brush my teeth, stretch, drink water, and take my vitamins.",
      // Derived structure: the request enumerates items without counting
      // them — the preview must resolve to four distinct habits ("four"
      // appears in no user turn, so echo cannot pass).
      responseIncludesAny: ["four", "all 4", "4 habits", "4 separate"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose four distinct morning habits (brush teeth, stretch, drink water, take vitamins) anchored to the morning and ask the owner to confirm before saving. Claiming they are already saved, or collapsing them into a single habit, fails.",
      },
    },
    {
      kind: "message",
      name: "morning-routine confirm",
      text: "Yes, save all of those as morning habits.",
      // Save-confirmation semantics in words the prompt never used ("set
      // up" is omitted because the preview prompt itself says "Set up").
      responseIncludesAny: ["saved", "created", "scheduled", "added", "recorded"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Morning brush teeth", "Brush teeth morning"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Morning stretch", "Stretching"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Water", "Morning water"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Take vitamins",
      titleAliases: ["Vitamins", "Morning vitamins"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
