/**
 * Hygiene: water habit aligned to meal times — explicit at-meal cadence,
 * not interval. Verifies the agent picks the daily kind with breakfast,
 * lunch, dinner windows.
 *
 * De-echoed for #9310: the old turn assertions ("water", "meal", "breakfast",
 * "lunch", "dinner" / "water") were satisfiable by parroting the prompt. The
 * persisted meal-anchored definition (`definitionCountDelta`) is the
 * load-bearing outcome; the turn checks now enforce the two-phase commit —
 * no completion claim before the owner confirms, and a save confirmation (in
 * words the prompt never used) after.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.water-custom-cadence-with-meals",
  title: "Drink water with every meal",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "meal-anchored"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Water With Meals",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water meals preview",
      text: "Remind me to drink a glass of water with every meal: breakfast, lunch, and dinner.",
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a meal-anchored water reminder covering all three meals (breakfast, lunch, dinner) — not a generic every-N-hours interval — and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "water meals confirm",
      text: "Yes, save that.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      titleAliases: ["Water with meals", "Glass of water with meals"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
