/**
 * Proposed slots include the timezone label when the user explicitly
 * referenced one ("for the London office").
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkTimezoneLabels(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const tzSignals = ["london", "gmt", "bst", "uk time", "utc"];
  if (!tzSignals.some((s) => reply.includes(s))) {
    return `Reply omits the London timezone reference. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.timezone-respectful-proposal",
  title: "Proposal labels times with the requested timezone",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "timezone"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "TZ-Labeled Proposal",
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
      name: "tz-aware-proposal",
      room: "main",
      text: "Propose two 30-minute slots next week for the London office team — make sure the times are clear in their timezone too.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "timezone-labeled",
      predicate: checkTimezoneLabels,
    },
    judgeRubric({
      name: "scheduling-tz-label-rubric",
      threshold: 0.5,
      description: `User mentioned London timezone. Proposed slots must label times in London (GMT/BST/UK time) as well as the user's local TZ.`,
    }),
  ],
});
