/**
 * Hygiene: shower three times a week — weekly cadence with specific weekdays.
 *
 * De-echoed for #9310: the old turn assertions ("shower", "week" / "saved",
 * "shower") were satisfiable by parroting the prompt. The persisted weekly
 * Mon/Wed/Fri definition (`definitionCountDelta` with `requiredWeekdays`) is
 * the load-bearing outcome; the turn checks now enforce the derived spread
 * (three concrete weekdays — no weekday appears in any user turn) and the
 * two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.shower-weekly",
  title: "Shower three times a week",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "weekly"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Shower Weekly",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shower weekly preview",
      text: "Please remind me to shower three times a week.",
      // Derived spread: the preview must pin the three showers to the
      // canonical Mon/Wed/Fri weekdays the finalCheck requires — no weekday
      // name appears in any user turn, so echo cannot pass.
      responseIncludesAll: ["monday", "wednesday", "friday"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a three-times-weekly shower schedule on three specific spread-out weekdays (Monday/Wednesday/Friday) and ask the owner to confirm before saving. Claiming it is already saved, or leaving the days unspecified, fails.",
      },
    },
    {
      kind: "message",
      name: "shower weekly confirm",
      text: "Yes, save that routine.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shower",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 3, 5],
      requireReminderPlan: true,
    },
  ],
});
