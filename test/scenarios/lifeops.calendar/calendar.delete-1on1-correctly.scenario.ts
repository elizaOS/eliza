/**
 * Multi-match disambiguation — there are three 1:1 events seeded and the
 * user asks to "delete my 1:1". The agent must NOT pick one silently; it
 * must either ask which one or unambiguously name a single match (none
 * exists, so the correct behavior is to ask).
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkAgentDisambiguated(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (!reply) return "empty reply";
  // The user has three 1:1s — the agent must list them or ask which one,
  // NOT silently delete one.
  const namesSeeded = ["sam", "alex", "priya"];
  const namesMentioned = namesSeeded.filter((n) => reply.includes(n));
  if (namesMentioned.length < 2) {
    return `Agent should mention at least 2 of the 3 candidate 1:1s. Mentioned: ${namesMentioned.join(",")}. Reply: ${reply.slice(0, 300)}`;
  }
  const askSignals = ["which", "clarify", "specify", "ambig", "more than one"];
  if (!askSignals.some((s) => reply.includes(s))) {
    return `Agent didn't ask the user which 1:1 to delete. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.delete-1on1-correctly",
  title:
    "Three 1:1s seeded — agent disambiguates instead of guessing which to delete",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "disambiguation", "delete"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Delete 1:1 Disambiguation",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-three-1on1s",
      apply: seedCalendarCache({
        events: [
          {
            id: "sam-1on1",
            title: "1:1 with Sam",
            startOffsetMinutes: 24 * 60 + 10 * 60,
            durationMinutes: 30,
          },
          {
            id: "alex-1on1",
            title: "1:1 with Alex",
            startOffsetMinutes: 2 * 24 * 60 + 14 * 60,
            durationMinutes: 30,
          },
          {
            id: "priya-1on1",
            title: "1:1 with Priya",
            startOffsetMinutes: 3 * 24 * 60 + 11 * 60,
            durationMinutes: 30,
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ambiguous-delete-1on1",
      room: "main",
      text: "Delete my 1:1.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-disambiguated-not-guessed",
      predicate: checkAgentDisambiguated,
    },
    judgeRubric({
      name: "calendar-delete-disambiguation-rubric",
      threshold: 0.6,
      description: `User said "delete my 1:1" but THREE 1:1s exist (Sam, Alex, Priya). Correct: agent asks which one, or lists the matches and waits. Incorrect: agent silently picks one and deletes it, or guesses based on alphabetical order, or fabricates a 4th 1:1.`,
    }),
  ],
});
