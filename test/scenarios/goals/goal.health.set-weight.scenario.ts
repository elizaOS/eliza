/**
 * Health goal save flow: user states a weight-loss goal with a target
 * amount and deadline. Expect a goal-creating action and a +1 goal
 * count delta.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "goal.health.set-weight",
  title: "Set a health goal to lose 10 lbs by June",
  domain: "goals",
  tags: ["lifeops", "goals", "health", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Weight Goal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weight-goal preview",
      text: "I want a health goal: lose 10 lbs by June. I'll measure by weekly weigh-ins on Sunday mornings.",
      responseIncludesAny: ["10 lbs", "10 pounds", "June", "weigh", "weight"],
    },
    {
      kind: "message",
      name: "weight-goal confirm",
      text: "Yes, save that goal.",
      responseIncludesAny: ["saved", "goal"],
    },
  ],
  finalChecks: [
    {
      type: "goalCountDelta",
      title: "Lose 10 lbs by June",
      titleAliases: [
        "Lose 10 pounds by June",
        "Lose 10 lbs",
        "Weight loss: 10 lbs by June",
      ],
      delta: 1,
      expectedStatus: "active",
      requireDescription: true,
      requireSuccessCriteria: true,
    },
  ],
});
