/**
 * Hygiene: medication refill reminder 2 weeks before running out — one-off
 * future reminder, not a recurring habit.
 *
 * De-echoed for #9310: the old turn assertions ("refill", "november",
 * "weeks", "before" / "saved", "refill", "reminder") were satisfiable by
 * parroting the prompt. The persisted definition (`definitionCountDelta`) is
 * the load-bearing outcome; the turn checks now enforce the derived date
 * arithmetic (run-out November 20 minus 2 weeks = November 6 — a date that
 * appears in no user turn) and the two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.medication-refill-reminder-2-weeks-out",
  title: "Medication refill reminder 2 weeks before run-out",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "medication", "one-off"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Refill Reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "refill preview",
      text: "My medication runs out on November 20. Remind me 2 weeks before so I can refill it.",
      // Derived date arithmetic: November 20 minus 2 weeks = November 6 —
      // the computed date appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["november 6", "nov 6", "11/6", "the 6th"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must compute and name the concrete reminder date (November 6, two weeks before the November 20 run-out) and ask the owner to confirm before saving. Restating 'two weeks before' without the computed date, or claiming it is already saved, fails.",
      },
    },
    {
      kind: "message",
      name: "refill confirm",
      text: "Yes, save that reminder.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Refill medication",
      titleAliases: ["Medication refill", "Refill meds", "Refill prescription"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
