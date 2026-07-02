/**
 * Sleep: user wants a bedtime reminder 90 minutes before sleep — this
 * should create a habit/scheduled task tied to bedtime - 90min.
 *
 * De-echoed for #9310: the old turn assertions ("90"/"bed"/"wind",
 * "saved"/"wind"/"bed") were satisfiable by parroting the prompt. The
 * persisted definition (`definitionCountDelta`) is the load-bearing outcome;
 * the turn checks now enforce the two-phase commit instead — no completion
 * claim before the owner confirms, and a save confirmation (in words the
 * prompt never used) after.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "sleep.bedtime-reminder-90min-before",
  title: "Bedtime wind-down reminder 90 minutes before sleep",
  domain: "lifeops.sleep",
  tags: ["lifeops", "sleep", "habit", "reminder"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Sleep Bedtime Reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bedtime preview",
      text: "Remind me 90 minutes before bed every night so I can wind down.",
      // Two-phase commit: the preview must not claim the reminder was already
      // persisted before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a concrete nightly wind-down reminder anchored 90 minutes before bedtime and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no schedule, fails.",
      },
    },
    {
      kind: "message",
      name: "bedtime confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Wind down",
      titleAliases: [
        "Bedtime wind down",
        "Wind-down reminder",
        "Pre-bed wind-down",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
