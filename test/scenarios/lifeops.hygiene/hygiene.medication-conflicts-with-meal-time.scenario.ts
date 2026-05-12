/**
 * Hygiene: medication conflicts with a meal-time pref. User asks for "8am
 * with food" but their breakfast pref is set to 9am — the agent should ask
 * for clarification rather than guessing.
 */

import { scenario } from "@elizaos/scenario-schema";
import { seedMeetingPreferences } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "hygiene.medication-conflicts-with-meal-time",
  title: "Medication time conflicts with stored breakfast preference",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "medication", "clarification"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Medication Conflict",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-late-breakfast",
      apply: seedMeetingPreferences({
        timeZone: "America/Los_Angeles",
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "med conflict preview",
      text: "Remind me to take my meds at 8am with food, but I usually don't eat until 9.",
      responseIncludesAny: ["8", "9", "food", "breakfast", "eat"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-surfaces-conflict-or-asks",
      predicate: (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
        if (!reply) return "empty agent reply";
        const conflictSignals = [
          "conflict",
          "9",
          "nine",
          "later",
          "breakfast",
          "eat",
          "food",
          "after",
          "shift",
        ];
        const hasSignal = conflictSignals.some((s) => reply.includes(s));
        if (!hasSignal) {
          return `agent should acknowledge the meal/medication timing tension; reply did not mention 9, breakfast, food, or shifting times. Reply: ${reply.slice(0, 300)}`;
        }
        return undefined;
      },
    },
  ],
});
