/**
 * Agent adds a 15-minute prep block before a 1:1.
 *
 * Tests the "prep-buffer" feature where the agent proactively creates a
 * companion event of 15 minutes immediately preceding a high-context
 * meeting.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkPrepBlockCreated(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({
      parameters: c.parameters ?? null,
      data: c.result?.data ?? null,
      text: c.result?.text ?? null,
    })),
  ).toLowerCase();
  const prepSignals = [
    "prep",
    "preparation",
    "before",
    "preceding",
    "15-min",
    "15 min",
    "buffer",
  ];
  if (!prepSignals.some((s) => blob.includes(s))) {
    return `Action payload didn't reference a prep/buffer block. Payload: ${blob.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.add-prep-buffer-before-1on1",
  title: "Adds a 15-min prep block before a 1:1",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "prep-buffer"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Prep Buffer",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-1on1",
      apply: seedCalendarCache({
        events: [
          {
            id: "1on1-with-cto",
            title: "1:1 with CTO",
            startOffsetMinutes: 24 * 60 + 11 * 60,
            durationMinutes: 30,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "add-prep-buffer",
      room: "main",
      text: "Add 15 minutes of prep time before my 1:1 with the CTO tomorrow.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "prep-block-created",
      predicate: checkPrepBlockCreated,
    },
    judgeRubric({
      name: "calendar-prep-buffer-rubric",
      threshold: 0.6,
      description: `User asked to add a 15-min prep block before the 11am 1:1 with CTO. Correct: agent creates a 15-min event ending at 11am (i.e. 10:45-11:00). Incorrect: agent extends the existing meeting, creates a buffer at the wrong time, or misses the prep intent.`,
    }),
  ],
});
