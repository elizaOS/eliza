/**
 * Cross-city flight requires a much larger travel buffer than a typical
 * 15-30 min commute. Agent must NOT apply the default 15-min buffer to a
 * meeting that requires a flight.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkFlightBufferReasoning(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "flight",
    "fly",
    "travel day",
    "hours",
    "block the day",
    "block the whole",
    "different city",
    "airport",
    "logistics",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't reason about the flight/travel constraint. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.cross-city-flight-buffer",
  title: "Cross-city flight requires a multi-hour travel buffer, not 15-min default",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "flight"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-City Flight Buffer",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
        defaultDurationMinutes: 60,
        travelBufferMinutes: 15,
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
      name: "create-cross-city-meeting",
      room: "main",
      text: "Schedule a 1-hour meeting in Austin tomorrow at 2pm Central. I'm flying in from SF that morning.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "flight-buffer-reasoned",
      predicate: checkFlightBufferReasoning,
    },
    judgeRubric({
      name: "travel-buffer-flight-rubric",
      threshold: 0.6,
      description: `User is flying SF -> Austin same morning as a 2pm Austin meeting. Correct: agent acknowledges the flight constraint and blocks travel time (hours, not minutes), or asks about flight time. Incorrect: agent applies the default 15-min buffer.`,
    }),
  ],
});
