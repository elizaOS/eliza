/**
 * Career goal save flow: user states a quarterly career goal. Expect a
 * goal-creating action and a +1 goal count delta.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "goal.career.set-quarterly",
  title: "Set a Q2 career goal to ship Eliza v2",
  domain: "goals",
  tags: ["lifeops", "goals", "career", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Career Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "career-goal preview",
      text: "My Q2 career goal is to ship Eliza v2 by the end of June. Success means a public release, at least 500 active users, and a shipped iOS companion app.",
      responseIncludesAny: ["Eliza", "Q2", "ship", "June"],
    },
    {
      kind: "message",
      name: "career-goal confirm",
      text: "Yes, save that career goal.",
      responseIncludesAny: ["saved", "goal"],
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Ship Eliza v2",
      titleAliases: [
        "Ship Eliza v2 by end of Q2",
        "Eliza v2 Q2",
        "Q2 ship Eliza v2",
      ],
      delta: 1,
      expectedStatus: "active",
      requireDescription: true,
      requireSuccessCriteria: true,
    },
  ],
});
