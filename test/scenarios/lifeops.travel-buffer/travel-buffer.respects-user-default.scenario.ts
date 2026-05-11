/**
 * The seeded travelBufferMinutes preference is 30 (not 15). When the agent
 * adds a travel buffer, it must match the seeded default — not silently
 * insert 15.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkBufferMatches30Min(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const blob = JSON.stringify(
    calls.map((c) => ({ p: c.parameters ?? null, d: c.result?.data ?? null })),
  ).toLowerCase();
  // Either the action payload mentions 30-min buffer, or the reply does.
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const combined = `${blob} ${reply}`;
  const thirtyMinSignals = ["30 min", "30-min", "thirty min", "30 minutes"];
  if (!thirtyMinSignals.some((s) => combined.includes(s))) {
    return `Travel buffer doesn't reference the seeded 30-min default. Combined: ${combined.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.respects-user-default",
  title: "Travel buffer uses the seeded 30-min user default, not a generic 15-min",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "preferences"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "User Default Travel Buffer",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs-30min-buffer",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
        defaultDurationMinutes: 60,
        travelBufferMinutes: 30,
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
      name: "create-with-default-buffer",
      room: "main",
      text: "Schedule a meeting at the client's office tomorrow at 2pm. Add my usual travel buffer.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "buffer-matches-30min",
      predicate: checkBufferMatches30Min,
    },
    judgeRubric({
      name: "travel-buffer-default-rubric",
      threshold: 0.6,
      description: `Seeded travelBufferMinutes is 30. Correct: travel buffer added is 30 minutes (matching the user's saved default). Incorrect: buffer is 15-min, 0 (no buffer), or some other arbitrary value.`,
    }),
  ],
});
