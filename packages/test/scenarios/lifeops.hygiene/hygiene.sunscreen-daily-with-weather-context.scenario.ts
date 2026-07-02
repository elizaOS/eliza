/**
 * Hygiene: sunscreen every morning — agent should create a daily habit and
 * (when surfaced via the morning brief) acknowledge weather context. This
 * scenario focuses on creation only; weather-conditional firing is a runtime
 * concern owned by the orchestrator.
 *
 * De-echoed for #9310: the old turn assertions ("sunscreen", "morning" /
 * "saved", "sunscreen") were satisfiable by parroting the prompt. The
 * persisted daily morning definition (`definitionCountDelta`) is the
 * load-bearing outcome; the turn checks now enforce the derived cadence
 * ("every morning" -> a daily habit — "daily" appears in no user turn) and
 * the two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.sunscreen-daily-with-weather-context",
  title: "Sunscreen every morning with weather context",
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
      title: "LifeOps Hygiene Sunscreen",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "sunscreen preview",
      text: "Remind me to put on sunscreen every morning before I head out.",
      // Derived cadence: "every morning" must resolve to a daily habit —
      // "daily" appears in no user turn, so echo cannot pass.
      responseIncludesAny: ["daily", "each morning"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a daily sunscreen habit anchored to a concrete morning slot and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "sunscreen confirm",
      text: "Yes, save that.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Sunscreen",
      titleAliases: ["Put on sunscreen", "Apply sunscreen"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
