/**
 * Propose-times that explicitly references the named attendees in the
 * generated proposal text.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkAttendeesNamed(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  for (const n of ["mira", "luc"]) {
    if (!reply.includes(n)) {
      return `Reply omits attendee "${n}". Reply: ${reply.slice(0, 300)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "scheduling.propose-times-with-attendees",
  title: "Proposes times that name both invitees",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "propose-times", "attendees"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Propose With Attendees",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
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
      name: "propose-with-attendees",
      room: "main",
      text: "Propose two 30-minute slots next week to set up a chat with Mira (mira@example.test) and Luc (luc@example.test).",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "attendees-named-in-reply",
      predicate: checkAttendeesNamed,
    },
    judgeRubric({
      name: "scheduling-attendees-rubric",
      threshold: 0.6,
      description: `User asked to schedule with Mira and Luc. Proposal must mention both names. Bonus: includes the emails. Incorrect: omits an attendee.`,
    }),
  ],
});
