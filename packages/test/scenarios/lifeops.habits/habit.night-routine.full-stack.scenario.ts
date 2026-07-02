/**
 * Multi-habit creation for a nightly wind-down routine: brush teeth,
 * stretch, and a wind-down step. Mirror of the morning routine scenario.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "habit.night-routine.full-stack",
  title: "Set up a full night routine in one request",
  domain: "habits",
  tags: ["lifeops", "habits", "multi-action"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Night Routine",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "night-routine preview",
      text: "Build my night routine: brush my teeth, do an evening stretch, and a 15-minute wind-down before bed.",
      // Derived structure: the request enumerates items without counting
      // them — the preview must resolve to three distinct habits ("three"
      // appears in no user turn, so echo cannot pass).
      responseIncludesAny: ["three", "3 habits", "3 separate"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose three distinct nightly habits (brush teeth, evening stretch, 15-minute wind-down) anchored to the night slot and ask the owner to confirm before saving. Claiming they are already saved fails.",
      },
    },
    {
      kind: "message",
      name: "night-routine confirm",
      text: "Yes, save those as my nightly habits.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Night brush teeth", "Evening brush teeth"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Evening stretch", "Night stretch"],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Wind down",
      titleAliases: [
        "Wind-down",
        "Bedtime wind down",
        "Evening wind down",
        "Pre-bed wind-down",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
