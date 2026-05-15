/**
 * Weekend availability is OFF by default. When the user explicitly asks
 * for a weekend slot, the agent should either honor it OR explain the
 * weekend-off preference and confirm before proposing.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkWeekendHandled(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "weekend",
    "saturday",
    "sunday",
    "off",
    "prefer not",
    "weekday",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't acknowledge weekend constraint. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.weekend-availability-toggle",
  title: "Handles weekend-availability request against weekday-only prefs",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "weekend"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Weekend Availability",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-weekday-only-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "17:00",
        defaultDurationMinutes: 30,
        blackoutWindows: [
          {
            label: "Weekend off",
            startLocal: "00:00",
            endLocal: "23:59",
            daysOfWeek: [0, 6],
          },
        ],
      }),
    },
    {
      type: "custom",
      name: "seed-empty",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-saturday-slot",
      room: "main",
      text: "Find me 30 minutes Saturday morning to catch up with my cousin.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "weekend-acknowledged",
      predicate: checkWeekendHandled,
    },
    judgeRubric({
      name: "scheduling-weekend-rubric",
      threshold: 0.5,
      description: `User asked for Saturday despite weekday-only blackout. Correct: agent either honors the request and acknowledges the override, or asks to confirm. Incorrect: agent silently books Saturday without acknowledging the preference, OR refuses outright without offering Saturday.`,
    }),
  ],
});
