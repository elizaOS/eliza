/**
 * Hygiene: water default frequency — colloquial "help me remember to drink
 * water" should resolve to a sensible interval (every 3 hours, ~4 times
 * during the day).
 *
 * De-echoed for #9310: the old turn assertions ("drink water", "water" /
 * "saved", "water") were satisfiable by parroting the prompt. The persisted
 * 180-minute interval definition (`definitionCountDelta`) is the
 * load-bearing outcome; the turn checks now enforce the derived default
 * cadence (the user gave no frequency — every number in the preview is
 * derived) and the two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.water-default-frequency",
  title: "Drink water default daily frequency",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "interval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Water Default",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water default preview",
      text: "help me remember to drink water",
      // Derived default cadence: the user gave no frequency, so any concrete
      // interval in the preview is computed, not echoed.
      responseIncludesAny: ["3 hours", "three hours", "4 times", "four times"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a sensible default hydration cadence (roughly every 3 hours, about 4 times across the waking day) and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete cadence, fails.",
      },
    },
    {
      kind: "message",
      name: "water default confirm",
      text: "yes, save it",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 180,
      requiredMaxOccurrencesPerDay: 4,
      requiredWindows: ["morning", "afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
