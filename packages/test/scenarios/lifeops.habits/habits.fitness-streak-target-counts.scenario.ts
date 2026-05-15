/**
 * Habits: 100 pushups daily target with partial credit — the user did 60.
 * The agent should record the partial completion and not reset the streak.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "habits.fitness-streak-target-counts",
  title: "Fitness target habit credits partial completion",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "fitness", "partial"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Pushups Partial",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-pushups-habit",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "100 pushups",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "partial-claim",
      text: "I only got 60 pushups in today, not the full 100.",
      responseIncludesAny: ["60", "pushups", "partial", "still"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-credits-partial",
      predicate: (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        if (reply.includes("reset") || reply.includes("doesn't count")) {
          return `agent should credit partial completion, not reset streak. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
