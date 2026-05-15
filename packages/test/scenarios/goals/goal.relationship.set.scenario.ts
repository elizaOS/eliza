/**
 * Relationship goal save flow: user states an annual relationship goal
 * ("stay in closer touch with family"). Expect a goal-creating action
 * and a +1 goal count delta.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
      responseIncludesAny: ["family", "call", "closer", "touch"],
    },
    {
      kind: "message",
      name: "relationship-goal confirm",
      text: "Yes, save that goal.",
      responseIncludesAny: ["saved", "goal", "family"],
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
