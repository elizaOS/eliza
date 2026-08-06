/**
 * Hygiene: lip balm during cold weather — interval habit during the winter
 * months. The agent should create an interval-based habit, not a one-off
 * reminder.
 *
 * De-echoed for #9310: the old turn assertions ("lip balm", "hours", "cold" /
 * "saved", "lip balm") were satisfiable by parroting the prompt. The
 * persisted interval definition (`definitionCountDelta`) is the load-bearing
 * outcome; the turn checks now enforce the derived cadence (the preview must
 * resolve "every few hours" to a concrete interval — no number of hours
 * appears in any user turn) and the two-phase commit.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.lip-balm-cold-weather",
  title: "Lip balm every few hours during cold weather",
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
      title: "LifeOps Hygiene Lip Balm",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "lip balm preview",
      text: "Remind me to put on lip balm every few hours when it's cold out.",
      // Derived cadence: "every few hours" must resolve to a concrete
      // interval — no number of hours appears in any user turn.
      responseIncludesAny: ["every 2", "every 3", "2 hours", "3 hours"],
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose an interval-based lip-balm reminder with a concrete cadence (e.g. every 2-3 hours) and ask the owner to confirm before saving. Claiming it is already saved, or proposing a single one-off reminder, fails.",
      },
    },
    {
      kind: "message",
      name: "lip balm confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Lip balm",
      titleAliases: ["Apply lip balm", "Put on lip balm"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
