/**
 * Habits: user was sick yesterday — the streak should be excusable. The
 * agent should offer to mark yesterday as an excused absence rather than
 * resetting the streak.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedCheckinDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "habits.broken-streak-with-exception",
  title: "Streak with sick-day exception is preserved",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "streak", "exception"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Habits Sick Day",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-stretch-habit",
      apply: seedCheckinDefinition({
        id: "habit-checkin-stretch",
        title: "Stretch",
        kind: "habit",
        dueAt: "{{now-26h}}",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "sick-day-claim",
      text: "Hey I was sick yesterday, please don't count that against my stretch streak.",
      responseIncludesAny: ["sick", "stretch", "streak", "excuse", "rest"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-acknowledges-exception",
      predicate: (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        const acknowledged =
          reply.includes("sick") ||
          reply.includes("rest") ||
          reply.includes("excuse") ||
          reply.includes("won't count") ||
          reply.includes("will not count") ||
          reply.includes("hope you feel better");
        if (!acknowledged) {
          return `agent should acknowledge the sick-day exception. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
