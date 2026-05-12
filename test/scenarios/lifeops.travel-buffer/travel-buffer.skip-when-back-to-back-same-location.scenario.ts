/**
 * Two back-to-back events at the SAME location — no travel buffer needed
 * between them. The agent must NOT auto-insert a buffer.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkNoBufferInserted(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // The agent's reply should mention NOT adding a buffer, OR not raise the
  // buffer topic at all.
  if (reply.includes("travel buffer") || reply.includes("travel time")) {
    // Acceptable if the agent says "skip" or "same location" — i.e. it
    // explicitly reasoned about it.
    const skipSignals = [
      "skip",
      "no buffer",
      "no travel",
      "same location",
      "same place",
      "back-to-back",
      "back to back",
      "not needed",
    ];
    if (!skipSignals.some((s) => reply.includes(s))) {
      return `Agent mentioned travel buffer/time but didn't acknowledge it should be skipped for same-location events. Reply: ${reply.slice(0, 300)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.skip-when-back-to-back-same-location",
  title: "No travel buffer added between back-to-back same-location meetings",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "calendar"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Same-Location No Buffer",
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
      name: "seed-first-event-at-office",
      apply: seedCalendarCache({
        events: [
          {
            id: "office-event-1",
            title: "Standup",
            startOffsetMinutes: 24 * 60 + 9 * 60,
            durationMinutes: 30,
            location: "456 Market St — HQ",
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-adjacent-same-location",
      room: "main",
      text: "Add a follow-up working session at HQ tomorrow at 9:30am for 30 minutes — same place as the 9am standup.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "no-buffer-inserted-same-location",
      predicate: checkNoBufferInserted,
    },
    judgeRubric({
      name: "travel-buffer-same-location-rubric",
      threshold: 0.5,
      description: `Two back-to-back events at HQ — no travel buffer needed. Correct: agent creates the second event without a travel buffer between them. Incorrect: agent inserts a buffer block between two same-location events.`,
    }),
  ],
});
