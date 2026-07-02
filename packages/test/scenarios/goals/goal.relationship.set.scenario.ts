/**
 * Relationship goal save flow: user states an annual relationship goal
 * ("stay in closer touch with family"). Expect a goal-creating action
 * and a +1 goal count delta.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "goal.relationship.set",
  title: "Set a relationship goal to stay in closer touch with family",
  domain: "goals",
  tags: ["lifeops", "goals", "relationships", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Relationship Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "relationship-goal preview",
      text: "My goal is to stay in closer touch with family this year. I want to call each parent at least once a week and text my siblings a few times a month.",
      // Derived cadence normalization: "once a week" -> weekly and "a few
      // times a month" -> monthly — neither token appears in any user turn,
      // so echo cannot pass.
      responseIncludesAny: ["weekly", "monthly"],
      // Two-phase commit: no persistence claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a relationship goal with the two measurable success criteria (weekly calls to each parent, monthly texts to siblings) and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "relationship-goal confirm",
      text: "Yes, save that goal.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "added", "recorded", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Stay in closer touch with family",
      titleAliases: [
        "Stay closer with family",
        "Closer touch with family",
        "Family connection",
      ],
      delta: 1,
      expectedStatus: "active",
      requireDescription: true,
      requireSuccessCriteria: true,
    },
  ],
});
