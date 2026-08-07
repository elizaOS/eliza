/**
 * Hygiene: moisturizer after every shower — daily habit linked conceptually
 * to the shower habit. The agent should not collapse the two; this is its
 * own definition tied to morning + night (or after the user's shower window).
 *
 * De-echoed for #9310: the old turn assertions ("moisturizer", "shower" /
 * "saved", "moisturizer") were satisfiable by parroting the prompt. The
 * persisted definition (`definitionCountDelta`) is the load-bearing outcome;
 * the turn checks now enforce the two-phase commit — a judged preview with
 * no persistence claim, then a save confirmation in words the prompt never
 * used.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hygiene.moisturizer-after-shower",
  title: "Moisturizer after every shower",
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
      title: "LifeOps Hygiene Moisturizer",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "moisturizer preview",
      text: "Remind me to put on moisturizer after every shower.",
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a moisturizer reminder anchored to the owner's shower routine (a distinct habit, not folded into the shower itself) and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "moisturizer confirm",
      text: "Yes, save it.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Moisturizer",
      titleAliases: ["Apply moisturizer", "Put on moisturizer"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
