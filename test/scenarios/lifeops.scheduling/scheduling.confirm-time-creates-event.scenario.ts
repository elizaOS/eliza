/**
 * After proposing slots, the user confirms one — the agent must transition
 * from "proposing" to "creating" the event. The CALENDAR action's
 * parameters/result must reflect a write, not just another read.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkEventCreated(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const reply = String(ctx.turns?.[1]?.responseText ?? "").toLowerCase();
  const createSignals = [
    "scheduled",
    "booked",
    "confirmed",
    "created",
    "added",
    "on the calendar",
    "all set",
  ];
  if (!createSignals.some((s) => reply.includes(s))) {
    return `Agent didn't confirm an event was created after the user picked a time. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.confirm-time-creates-event",
  title: "User confirms a proposed slot — agent creates the event",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "confirmation"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Confirm-Then-Create",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "17:00",
        defaultDurationMinutes: 30,
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
      name: "ask-for-slots",
      room: "main",
      text: "Propose three 30-minute slots tomorrow for a chat with Renee.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
    {
      kind: "message",
      name: "confirm-second-slot",
      room: "main",
      text: "Book the second one.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "event-created-after-confirm",
      predicate: checkEventCreated,
    },
    judgeRubric({
      name: "scheduling-confirm-then-create-rubric",
      threshold: 0.6,
      description: `Two turns: propose three slots, then user said "book the second one". Correct: agent confirms an event was created at that slot. Incorrect: agent says "ok" without confirming creation, or proposes a new set of slots.`,
    }),
  ],
});
