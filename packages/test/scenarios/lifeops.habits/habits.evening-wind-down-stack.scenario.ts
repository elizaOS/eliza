/**
 * Habits: evening wind-down stack — 3 distinct evening habits in one
 * request. Distinct from the existing night-routine full-stack.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "habits.evening-wind-down-stack",
  title: "Evening wind-down stack: dim lights, journal, stretch",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "multi-action", "evening"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Evening Wind Down",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "evening stack preview",
      text: "Help me set up an evening wind-down: dim the lights, journal for 5 minutes, and stretch before bed.",
      // Derived schedule: the user gave no time, so any concrete evening
      // clock time in the preview is computed, not echoed ("three" cannot
      // anchor this file — it appears in the confirm turn's text).
      responseIncludesAny: [" pm", ":00", ":30"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose three distinct evening habits (dim lights, 5-minute journal, stretch) anchored to a concrete evening time and ask the owner to confirm before saving. Claiming they are already saved, or leaving the timing unspecified, fails.",
      },
    },
    {
      kind: "message",
      name: "evening stack confirm",
      text: "Yes, save all three as evening habits.",
      // Save-confirmation semantics in words the prompt never used ("set
      // up" is omitted because the preview prompt itself says "set up").
      responseIncludesAny: ["saved", "created", "scheduled", "added", "recorded"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Dim lights",
      titleAliases: ["Dim the lights", "Evening lights"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Journal",
      titleAliases: ["Journaling", "Evening journal", "5-minute journal"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Evening stretch", "Night stretch", "Pre-bed stretch"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
