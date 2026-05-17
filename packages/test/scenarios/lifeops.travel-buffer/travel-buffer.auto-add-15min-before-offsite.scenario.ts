/**
 * Auto-add a 15-min travel buffer before an offsite meeting.
 *
 * When the user creates an event at an external location, the agent should
 * automatically add (or propose) a 15-min travel buffer immediately
 * preceding the event.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkTravelBufferAdded(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({
      p: c.parameters ?? null,
      d: c.result?.data ?? null,
      t: c.result?.text ?? null,
    })),
  ).toLowerCase();
  const signals = ["travel", "buffer", "15-min", "15 min", "drive", "commute"];
  if (!signals.some((s) => blob.includes(s))) {
    return `Action payload didn't reference travel buffer. Payload: ${blob.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.auto-add-15min-before-offsite",
  title: "Auto-adds a 15-min travel buffer before an offsite event",
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
      title: "Auto Travel Buffer",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs-with-travel-buffer",
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
      name: "create-offsite-event",
      room: "main",
      text: "Book lunch with Tessa tomorrow at 12:30pm at Tartine on Guerrero. I usually like a travel buffer before in-person things.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "travel-buffer-added",
      predicate: checkTravelBufferAdded,
    },
    judgeRubric({
      name: "travel-buffer-auto-rubric",
      threshold: 0.6,
      description: `User booked an offsite lunch and mentioned wanting a travel buffer. Correct: agent creates the event AND adds a 15-min travel buffer just before it (i.e. block at 12:15-12:30). Incorrect: agent creates the lunch alone with no buffer.`,
    }),
  ],
});
