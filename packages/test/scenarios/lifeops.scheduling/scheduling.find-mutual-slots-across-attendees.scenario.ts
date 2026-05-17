/**
 * Find mutual availability across multiple attendees — the agent must
 * acknowledge that mutual availability depends on each attendee's calendar
 * and either query it or surface the constraint.
 *
 * In the absence of attendee calendar feeds, the agent should propose slots
 * from the OWNER's calendar and frame them as "propose to attendees".
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkMutualHandling(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "mutual",
    "everyone",
    "all four",
    "common",
    "overlap",
    "their calendars",
    "their availability",
    "propose to them",
    "send to them",
    "ask them",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't address multi-attendee mutual availability. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.find-mutual-slots-across-attendees",
  title: "Handles a 4-person mutual-availability request",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "multi-attendee"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Mutual Slots",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "17:00",
        defaultDurationMinutes: 45,
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
      name: "ask-for-mutual",
      room: "main",
      text: "Find a 45-min slot that works for me, Hank, Priya, and Lin next week.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "mutual-availability-handled",
      predicate: checkMutualHandling,
    },
    judgeRubric({
      name: "scheduling-mutual-availability-rubric",
      threshold: 0.6,
      description: `4-person scheduling request. Correct: agent proposes slots from its own calendar AND acknowledges the need to confirm with the other 3 attendees. Incorrect: agent claims a single slot definitively works for all 4 without seeing their calendars.`,
    }),
  ],
});
