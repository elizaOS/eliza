/**
 * Hygiene: shower every morning — daily cadence anchored to the morning slot.
 *
 * De-echoed for #9310: the old turn assertions ("shower", "morning" /
 * "saved", "shower") were satisfiable by parroting the prompt. The persisted
 * daily morning definition (`definitionCountDelta`) is the load-bearing
 * outcome; the turn checks now enforce the derived cadence ("every morning"
 * -> a daily habit — "daily" appears in no user turn) and the two-phase
 * commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.shower-daily-morning",
  title: "Shower every morning",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Shower Daily",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shower daily preview",
      text: "Remind me to shower every morning when I wake up.",
      // Derived cadence: "every morning" must resolve to a daily habit —
      // "daily" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["daily", "each morning"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a daily shower habit anchored to a concrete morning slot and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "shower daily confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shower",
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
