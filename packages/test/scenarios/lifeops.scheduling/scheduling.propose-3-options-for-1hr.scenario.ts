/**
 * Propose three 1-hour options for a meeting later this week.
 *
 * The agent must actually produce 3 concrete slots, not "let me know what
 * works" or a generic answer.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkThreeOneHourSlots(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter((a) => a.actionName === "CALENDAR");
  if (calls.length === 0) return "expected CALENDAR action";
  const hit = calls[0];
  if (!hit) return "no calendar call";
  const data = (hit.result?.data ?? {}) as {
    slots?: unknown[];
    durationMinutes?: number;
  };
  if (Array.isArray(data.slots) && data.slots.length >= 3) {
    if (data.durationMinutes && data.durationMinutes !== 60) {
      return `expected 60-minute slots, got ${data.durationMinutes}`;
    }
    return undefined;
  }
  // Fall back to reply scan — three time strings.
  const reply = String(ctx.turns?.[0]?.responseText ?? "");
  const timeMatches = reply.match(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi) ?? [];
  if (timeMatches.length < 3) {
    return `Reply doesn't surface 3 distinct slots. Got ${timeMatches.length}. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.propose-3-options-for-1hr",
  title: "Proposes three 1-hour slots when asked",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "propose-times"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Propose Three 1hr Slots",
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
      name: "ask-3-1hr-slots",
      room: "main",
      text: "Give me three 1-hour slots later this week I can offer for a customer call.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "three-1hr-slots-proposed",
      predicate: checkThreeOneHourSlots,
    },
    judgeRubric({
      name: "scheduling-propose-3-1hr-rubric",
      threshold: 0.6,
      description: `Agent must propose THREE concrete 1-hour slots (not "let me know what works"). Times must be specific (day + clock time). Correct: 3 distinct slots, each clearly 1 hour. Incorrect: vague availability, single slot, or no slots.`,
    }),
  ],
});
