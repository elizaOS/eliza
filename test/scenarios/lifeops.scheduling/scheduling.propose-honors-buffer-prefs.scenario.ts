/**
 * Propose-times honors the user's between-meeting buffer preference. With
 * a 15-min default buffer set, two proposed back-to-back slots must NOT
 * abut existing meetings without the buffer.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkBufferPresent(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "buffer",
    "15 minutes",
    "15-min",
    "between meetings",
    "gap",
    "back-to-back",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Reply didn't acknowledge the 15-min buffer preference. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.propose-honors-buffer-prefs",
  title: "Proposals respect the user's 15-min between-meeting buffer",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "preferences"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Buffer Preference",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs-with-buffer",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "17:00",
        defaultDurationMinutes: 30,
        travelBufferMinutes: 15,
      }),
    },
    {
      type: "custom",
      name: "seed-one-existing-meeting",
      apply: seedCalendarCache({
        events: [
          {
            id: "existing-1030",
            title: "Existing call",
            startOffsetMinutes: 24 * 60 + 10 * 60 + 30,
            durationMinutes: 30,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-near-existing",
      room: "main",
      text: "Find me a 30-min slot tomorrow morning.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "buffer-acknowledged",
      predicate: checkBufferPresent,
    },
    judgeRubric({
      name: "scheduling-buffer-rubric",
      threshold: 0.5,
      description: `User has a 15-min buffer preference and one existing call at 10:30-11:00. Proposed morning slot should be at least 15 min away from 10:30 or 11:00 (so 10:15 or earlier, or 11:15 or later). Tolerable: the agent acknowledges the buffer or proposes a buffer-safe slot.`,
    }),
  ],
});
