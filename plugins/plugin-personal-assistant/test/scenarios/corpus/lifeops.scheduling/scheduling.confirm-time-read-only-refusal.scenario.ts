/**
 * After proposing slots, the user confirms one. Personal Google Calendar is
 * read-only, so the agent must preserve the selected slot but disclose that it
 * cannot create the event and must not claim success.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../../../scenario-support/lifeops-seeds.ts";

function checkEventCreationRefused(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const reply = String(ctx.turns?.[1]?.responseText ?? "").toLowerCase();
  if (
    !["read-only", "view-only", "can't", "cannot", "unsupported"].some((s) =>
      reply.includes(s),
    )
  ) {
    return `Agent did not disclose that personal Google Calendar creation is unavailable. Reply: ${reply.slice(0, 300)}`;
  }
  if (
    /\b(successfully (scheduled|booked|created|added)|(was|has been) (scheduled|booked|created|added)|all set)\b/.test(
      reply,
    )
  ) {
    return `Agent falsely claimed an event was created. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "scheduling.confirm-time-read-only-refusal",
  title:
    "Confirmed slot is preserved but Google Calendar creation fails closed",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "confirmation"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
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
      name: "event-creation-refused-after-confirm",
      predicate: checkEventCreationRefused,
    },
    judgeRubric({
      name: "scheduling-confirm-read-only-rubric",
      threshold: 0.6,
      description: `Two turns: propose three slots, then the user selects the second. Correct: agent preserves the selected slot, explains that personal Google Calendar is read-only, and states that no event was created. Incorrect: agent claims the event was booked, scheduled, created, or added.`,
    }),
  ],
});
