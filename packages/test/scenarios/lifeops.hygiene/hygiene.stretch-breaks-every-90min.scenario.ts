/**
 * Hygiene: stretch break every 90 minutes during work — interval cadence
 * with explicit minute count, not the generic "during the day" default.
 *
 * De-echoed for #9310: the old turn assertions ("stretch", "90", "minutes" /
 * "stretch") were satisfiable by parroting the prompt. The persisted
 * 90-minute interval definition (`definitionCountDelta` with
 * `requiredEveryMinutes: 90`) is the load-bearing outcome; the turn checks
 * now enforce the two-phase commit — no completion claim before the owner
 * confirms, and a save confirmation (in words the prompt never used) after.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.stretch-breaks-every-90min",
  title: "Stretch break every 90 minutes during work",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "interval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Stretch 90min",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "stretch preview",
      text: "Remind me to stand up and stretch every 90 minutes during the workday.",
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose an interval reminder that keeps the explicit 90-minute spacing scoped to working hours and ask the owner to confirm before saving. Rounding to hourly, dropping the workday scope, or claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "stretch confirm",
      text: "Yes, save that.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Stretch",
      titleAliases: ["Stretch break", "Stretch breaks"],
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 90,
      requireReminderPlan: true,
    },
  ],
});
