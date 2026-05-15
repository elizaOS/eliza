/**
 * The user asks for "15 minutes before my 2pm to get ready" — the agent
 * must distinguish prep buffer from travel buffer. For an offsite meeting
 * this is ambiguous: the agent should either ask, or set up both, or
 * acknowledge the distinction.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkPrepVsTravelDistinguished(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const distinguishSignals = [
    "prep",
    "preparation",
    "travel",
    "commute",
    "drive",
    "transit",
    "in addition",
    "as well",
    "or both",
    "ready",
  ];
  const matches = distinguishSignals.filter((s) => reply.includes(s));
  if (matches.length < 2) {
    return `Agent didn't distinguish prep vs travel context. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.adjacent-meeting-prep-vs-travel-distinguish",
  title: "Distinguishes prep buffer from travel buffer when both are relevant",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "prep-buffer"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Prep vs Travel",
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
      name: "seed-offsite-meeting",
      apply: seedCalendarCache({
        events: [
          {
            id: "offsite-2pm",
            title: "Client visit",
            startOffsetMinutes: 24 * 60 + 14 * 60,
            durationMinutes: 60,
            location: "789 Mission St — Client HQ",
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ambiguous-15min-before",
      room: "main",
      text: "I need 15 minutes before my 2pm offsite tomorrow to get ready.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "prep-vs-travel-distinguished",
      predicate: checkPrepVsTravelDistinguished,
    },
    judgeRubric({
      name: "travel-buffer-prep-vs-travel-rubric",
      threshold: 0.5,
      description: `User asked for "15 min before to get ready" for an offsite meeting. Both prep and travel are needed. Correct: agent either creates both prep + travel buffers, or asks which (or both). Incorrect: agent creates only one without acknowledging the other concern.`,
    }),
  ],
});
