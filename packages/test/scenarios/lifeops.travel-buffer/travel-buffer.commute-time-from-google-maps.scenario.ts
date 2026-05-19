/**
 * Travel buffer derived from an actual commute estimate (e.g. Google Maps).
 *
 * Wave-3 follow-up: a real maps mock would inject a commute-time response.
 * For now this scenario sets the user's home address in seeded prefs and
 * asks the agent to create an event at a different address — the buffer
 * should be larger than 15 min (the default) for a real-world cross-town
 * trip OR the agent should explain that it doesn't have a maps integration.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkCommuteBufferHandled(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "travel",
    "commute",
    "drive",
    "map",
    "transit",
    "minutes",
    "buffer",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't address commute time. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.commute-time-from-google-maps",
  title:
    "Cross-town offsite — buffer reflects real commute estimate or surface limit",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "maps", "needs-richer-fixtures"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Maps Commute Buffer",
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
      name: "create-cross-town-event",
      room: "main",
      text: "Schedule a 1-hour meeting at 1000 El Camino Real, Palo Alto tomorrow at 3pm. I'm coming from home in San Francisco — add an appropriate travel buffer based on real commute time.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "commute-buffer-handled",
      predicate: checkCommuteBufferHandled,
    },
    judgeRubric({
      name: "travel-buffer-commute-rubric",
      threshold: 0.5,
      description: `Cross-town SF->Palo Alto requires real commute time (~45 min). Correct: agent either uses a real estimate (>=30 min buffer) or explicitly states it lacks a maps integration and falls back to the user default. Incorrect: agent silently uses 15 min for a 45-min drive.`,
    }),
  ],
});
