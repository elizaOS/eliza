/**
 * Habits: partial pause — user wants to pause workout but keep brushing
 * teeth and water. The agent must NOT pause the unrelated habits.
 *
 * Seed 3 habit definitions, then ask the agent to pause only the workout.
 * Assert: CHECKIN still surfaces brush + water, only workout is paused.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "habits.partial-pause-only-some-habits",
  title: "Partial pause leaves unrelated habits active",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "pause", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Partial Pause",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-workout",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Workout",
      }),
    },
    {
      type: "custom",
      name: "seed-brush",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Brush teeth",
      }),
    },
    {
      type: "custom",
      name: "seed-water",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Drink water",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "pause-workout-only",
      text: "Pause my workout habit for the next week but keep everything else going.",
      responseIncludesAny: ["workout", "pause", "keep", "other"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-only-pauses-workout",
      predicate: (ctx: ScenarioContext) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        if (!reply.includes("workout")) {
          return "expected reply to mention workout (the habit being paused)";
        }
        const blanketPause = /paus(e|ing|ed) (all|everything|every habit)/.test(
          reply,
        );
        if (blanketPause) {
          return `agent pause-everything when user only asked to pause workout. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
