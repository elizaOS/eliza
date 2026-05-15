/**
 * Hygiene: shave twice a week with a formal phrasing — the agent must
 * mirror the user's tone (no slang, no exclamation marks) while still
 * confirming the routine.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "hygiene.shave-weekly-formal-tone",
  title: "Shave twice a week — formal user phrasing",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "weekly", "tone"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Hygiene Shave Formal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shave preview",
      text: "Please remind me to shave twice a week.",
      responseIncludesAny: ["shave", "twice", "weekly"],
    },
    {
      kind: "message",
      name: "shave confirm",
      text: "Yes, save that habit.",
      responseIncludesAny: ["saved", "shave"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shave",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 4],
      requireReminderPlan: true,
    },
    judgeRubric({
      name: "shave-formal-tone-mirroring",
      threshold: 0.6,
      description:
        "The user wrote in a formal, polite register. The agent should reply in a matching register — brief and courteous, without slang, emojis, or excessive exclamation marks. Score 1 if the reply mirrors the formal tone; score 0 if it's overly casual or sprinkled with exclamation marks.",
    }),
  ],
});
