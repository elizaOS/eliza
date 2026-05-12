/**
 * Habits: cross-platform habit acknowledgment — habit was created via
 * Telegram but the user acks completion from iMessage (BlueBubbles). Both
 * sources should converge to the same definition.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedLifeOpsDefinition } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "habits.cross-platform-habit-via-imessage",
  title: "Habit completion ack from iMessage updates the same definition",
  domain: "lifeops.habits",
  tags: ["lifeops", "habits", "cross-platform", "imessage"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "bluebubbles",
      title: "iMessage Habit Ack",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-meditate-habit",
      apply: seedLifeOpsDefinition({
        kind: "habit",
        title: "Meditate",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ack-from-imessage",
      text: "Done meditating just now.",
      responseIncludesAny: ["meditat", "logged", "noted", "nice", "great"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-acks-completion",
      predicate: (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty reply";
        if (
          !reply.includes("meditat") &&
          !reply.includes("logged") &&
          !reply.includes("noted") &&
          !reply.includes("got it")
        ) {
          return `agent should acknowledge meditation completion. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
