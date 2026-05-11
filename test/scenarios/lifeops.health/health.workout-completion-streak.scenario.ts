/**
 * Health: workout completion streak — user has a daily workout habit and
 * asks for their current streak. The HEALTH action should read workout
 * data and CHECKIN should report streak.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "health.workout-completion-streak",
  title: "Workout completion streak from health data",
  domain: "lifeops.health",
  tags: ["lifeops", "health", "streak", "workout"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Workout Streak",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-workout-habit",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Workout",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "workout-streak",
      text: "What's my workout streak right now?",
      expectedActions: ["CHECKIN", "HEALTH"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-cites-streak-or-no-data",
      predicate: (ctx) => {
        const reply = String(
          ctx.turns?.[0]?.responseText ?? "",
        ).toLowerCase();
        if (!reply) return "empty reply";
        const responded =
          reply.includes("streak") ||
          reply.includes("workout") ||
          reply.includes("haven't") ||
          reply.includes("don't have") ||
          reply.includes("no data") ||
          /\d+ day/.test(reply);
        if (!responded) {
          return `agent should report streak or admit no data. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
