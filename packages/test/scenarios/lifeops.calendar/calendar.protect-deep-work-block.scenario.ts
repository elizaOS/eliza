/**
 * Agent refuses (or pushes back) when asked to schedule a meeting over a
 * pre-existing "Deep work" block, even if technically available.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkDeepWorkProtected(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const protectSignals = [
    "deep work",
    "deep-work",
    "focus",
    "protect",
    "won't",
    "wont",
    "instead",
    "alternative",
    "another time",
    "different time",
  ];
  if (!protectSignals.some((s) => reply.includes(s))) {
    return `Agent didn't push back on a meeting during the deep-work block. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.protect-deep-work-block",
  title: "Refuses to schedule over an existing deep-work block by default",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "time-defense", "focus"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Deep Work Defense",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-deep-work-block",
      apply: seedCalendarCache({
        events: [
          {
            id: "deep-work-block",
            title: "Deep work",
            startOffsetMinutes: 24 * 60 + 10 * 60,
            durationMinutes: 120,
            metadata: { category: "focus", protected: true },
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule-into-deep-work",
      room: "main",
      text: "Schedule a 30-minute sync with Jordan tomorrow at 10:30am.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "deep-work-protected",
      predicate: checkDeepWorkProtected,
    },
    judgeRubric({
      name: "calendar-protect-deep-work-rubric",
      threshold: 0.6,
      description: `User asked to schedule a meeting at 10:30am tomorrow, which falls inside a seeded 10:00-12:00 deep work block. Correct: agent flags the conflict and suggests an alternative time. Incorrect: agent silently schedules over the deep work block.`,
    }),
  ],
});
