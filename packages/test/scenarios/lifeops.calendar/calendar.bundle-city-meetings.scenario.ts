/**
 * Bundle adjacent meetings compactly when the user is traveling to a
 * different city. When several people in NYC all want time during the user's
 * single-day NYC visit, the agent should propose adjacent slots, not
 * scatter them across the day.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkProposalSuggestsBundling(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "back-to-back",
    "back to back",
    "adjacent",
    "compact",
    "stack",
    "block",
    "bunch",
    "together",
    "consecutive",
    "in a row",
    "all in",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't suggest bundling adjacent meetings during the NYC visit. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.bundle-city-meetings",
  title: "Bundles NYC meetings compactly during a one-day visit",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "travel", "bundling"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "City Meeting Bundle",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
        defaultDurationMinutes: 45,
      }),
    },
    {
      type: "custom",
      name: "seed-empty-calendar",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bundle-nyc-day",
      room: "main",
      text: "I'm flying to NYC just for the day next Wednesday. Three people want to meet me in person there: Priya, Marcus, and Aria. Each meeting is 45 minutes. Stack them so I'm only in one place at a time and not bouncing across Manhattan.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "proposal-bundles-meetings",
      predicate: checkProposalSuggestsBundling,
    },
    judgeRubric({
      name: "calendar-bundle-city-rubric",
      threshold: 0.6,
      description: `User is in NYC for a single day with three 45-min meetings (Priya, Marcus, Aria). Correct: agent proposes them back-to-back or in a compact block, in some sensible order, and names all three people. Incorrect: agent scatters them across morning/afternoon/evening, or omits one of the three, or fails to acknowledge that the day is constrained.`,
    }),
  ],
});
