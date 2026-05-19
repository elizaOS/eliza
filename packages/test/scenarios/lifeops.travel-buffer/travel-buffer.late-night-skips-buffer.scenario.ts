/**
 * Late-night meeting (after 9pm) — travel buffer should be SKIPPED for
 * personal/casual events that don't need commute. Or at least the agent
 * should consult the user before auto-adding.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkLateNightHandled(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // The reply must address late-night context — either skip buffer or
  // explain.
  if (
    reply.includes("travel buffer") &&
    !reply.includes("skip") &&
    !reply.includes("no buffer") &&
    !reply.includes("won't") &&
    !reply.includes("wont")
  ) {
    return `Agent auto-added travel buffer to a late-night casual event. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.late-night-skips-buffer",
  title: "Late-night casual event skips the auto travel buffer",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "context-sensitive"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Late Night No Buffer",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "22:00",
        defaultDurationMinutes: 60,
        travelBufferMinutes: 15,
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
      name: "create-late-night-personal",
      room: "main",
      text: "Block 9:30pm tomorrow to watch the game.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "no-late-night-buffer",
      predicate: checkLateNightHandled,
    },
    judgeRubric({
      name: "travel-buffer-late-night-rubric",
      threshold: 0.5,
      description: `User created a personal "watch the game" block at 9:30pm. Travel buffer is irrelevant. Correct: agent creates the event WITHOUT a travel buffer, OR explicitly skips it. Incorrect: agent auto-adds a 15-min travel buffer at 9:15pm.`,
    }),
  ],
});
