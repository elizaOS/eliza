/**
 * Health: exercise goal progress — user wants to hit 5 workouts this week,
 * mid-week check-in. Agent should report progress and project whether the
 * goal is achievable.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsGoal } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "health.exercise-goal-progress-mid-week",
  title: "Mid-week check on weekly exercise goal",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "goal", "progress"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Exercise Goal",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-weekly-exercise-goal",
      apply: seedLifeOpsGoal({ title: "5 workouts per week" }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mid-week-progress",
      text: "How am I tracking on the 5 workouts goal this week?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-discusses-progress",
      predicate: (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        const onTopic =
          reply.includes("workout") ||
          reply.includes("5") ||
          reply.includes("goal") ||
          reply.includes("week") ||
          reply.includes("haven't") ||
          reply.includes("no data");
        if (!onTopic) {
          return `agent should discuss the workout goal. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
