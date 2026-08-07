/**
 * Career goal save flow: user states a quarterly career goal. Expect a
 * goal-creating action and a +1 goal count delta.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
      // Derived structure: the preview must restate the goal as a tracked
      // quarterly goal with explicit success criteria — neither "quarterly"
      // nor "criteria" appears in any user turn, so echo cannot pass.
      responseIncludesAny: ["quarterly", "criteria"],
      // Two-phase commit: no persistence claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose a quarterly career goal (ship Eliza v2 by end of June) with the three success criteria enumerated (public release, 500 active users, iOS companion app) and ask the owner to confirm before saving. Claiming it is already saved fails.",
      },
    },
    {
      kind: "message",
      name: "career-goal confirm",
      text: "Yes, save that career goal.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "added", "recorded", "set up"],
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
