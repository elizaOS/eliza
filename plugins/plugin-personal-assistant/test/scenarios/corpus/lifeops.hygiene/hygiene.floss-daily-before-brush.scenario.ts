/**
 * Hygiene: floss daily before brushing — the agent should create a single
 * daily evening habit and not collapse it into the brushing habit.
 *
 * De-echoed for #9310: the old turn assertions ("floss", "night" / "floss")
 * were satisfiable by parroting the prompt. The persisted definition
 * (`definitionCountDelta`) is the load-bearing outcome; the turn checks now
 * enforce the two-phase commit instead — no completion claim before the
 * owner confirms, and a save confirmation (in words the prompt never used)
 * after.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.floss-daily-before-brush",
  title: "Floss daily before brushing teeth at night",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Floss Daily",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "floss preview",
      text: "Remind me to floss every night before I brush my teeth.",
      // Two-phase commit: the preview must not claim the habit was already
      // persisted before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a concrete nightly floss reminder (evening/night timing, ordered before brushing) and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no schedule, fails.",
      },
    },
    {
      kind: "message",
      name: "floss confirm",
      text: "Yes, save that.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Floss",
      titleAliases: ["Floss teeth", "Floss every night", "Floss nightly"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["night", "evening"],
      requireReminderPlan: true,
    },
  ],
});
