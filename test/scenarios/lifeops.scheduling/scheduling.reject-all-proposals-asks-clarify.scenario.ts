/**
 * After proposing 3 slots, the user rejects them all. The agent must ask
 * for clarification (preferred time window? day? duration?) rather than
 * generate three more random slots in the same window.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkAgentAskedForGuidance(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[1]?.responseText ?? "").toLowerCase();
  if (!reply) return "empty reply on rejection";
  const clarifySignals = [
    "what time",
    "what window",
    "what days",
    "what day",
    "earlier",
    "later",
    "next week",
    "different day",
    "morning or afternoon",
    "afternoon or morning",
    "would work",
    "prefer",
    "constraints",
  ];
  if (!clarifySignals.some((s) => reply.includes(s))) {
    return `Agent didn't ask the user for guidance after rejecting all proposals. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.reject-all-proposals-asks-clarify",
  title: "All proposed slots rejected — agent asks for guidance",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "clarification"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Reject Then Clarify",
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
      text: "Give me three 30-minute slots tomorrow for a quick sync.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
    {
      kind: "message",
      name: "reject-all",
      room: "main",
      text: "None of these work.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-asked-for-guidance",
      predicate: checkAgentAskedForGuidance,
    },
    judgeRubric({
      name: "scheduling-reject-clarify-rubric",
      threshold: 0.6,
      description: `User said "none of these work" after a 3-slot proposal. Correct: agent asks what window/day/duration would work. Incorrect: agent re-proposes random slots without asking for the user's constraint.`,
    }),
  ],
});
