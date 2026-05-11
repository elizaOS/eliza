/**
 * Hygiene: brush teeth twice daily — canonical happy path.
 *
 * Adapted from the runtime fixture `plugins/app-lifeops/scenarios/brush-teeth-basic.json`
 * into the executable `.scenario.ts` form used by the workspace runner. The
 * existing runtime fixture stays in place to drive bench dispatch; this file
 * is the executable test-time form that lives under the workspace scenario
 * tree and is discovered by the scenario runner CLI.
 *
 * Assertion: the agent calls LIFE with create_definition for "Brush teeth"
 * at twice-per-day cadence (8am, 9pm), with a reminder plan attached.
 */

import { scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "hygiene.brush-teeth-twice-daily",
  title: "Brush teeth twice a day at 8am and 9pm",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Brush Teeth",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "brush-teeth preview",
      text: "Help me brush my teeth at 8 am and 9 pm every day.",
      responseIncludesAny: ["brush teeth", "brushing", "set that up"],
    },
    {
      kind: "message",
      name: "brush-teeth confirm",
      text: "Yes, save that brushing routine.",
      responseIncludesAny: ["saved", "brush"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Brush teeth",
      titleAliases: ["Brush Teeth", "Brush teeth 8 am & 9 pm"],
      delta: 1,
      cadenceKind: "times_per_day",
      requiredSlots: [{ minuteOfDay: 480 }, { minuteOfDay: 1260 }],
      requireReminderPlan: true,
    },
    judgeRubric({
      name: "hygiene-tone-warm-not-lecture",
      threshold: 0.6,
      description:
        "Hygiene reminders should be warm, brief, and free of moralizing or lecturing. The agent should confirm the brushing routine in plain, friendly terms; it should NOT include dental-health PSAs, statistics about cavities, or unsolicited oral-care tips. Score 0 if the reply lectures the user on dental hygiene; score 1 if it simply confirms the routine.",
    }),
  ],
});
