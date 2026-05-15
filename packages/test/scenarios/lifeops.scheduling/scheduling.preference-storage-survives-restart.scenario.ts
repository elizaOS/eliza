/**
 * Meeting preferences persist across the scenario boundary — once seeded,
 * a downstream query (turn 1) must surface them. This guards against the
 * agent re-asking for prefs every session.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkPrefsSurfaced(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // Expect surfacing of any specific seeded value: 30min, 09:30-16:00 etc.
  const signals = [
    "30",
    "thirty",
    "30-minute",
    "30 min",
    "9:30",
    "09:30",
    "4:00",
    "16:00",
    "lunch",
    "preferences",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Reply didn't echo any seeded preference. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.preference-storage-survives-restart",
  title: "Seeded meeting preferences are read back, not re-asked",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "preferences", "persistence"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Prefs Persistence",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-distinctive-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:30",
        preferredEndLocal: "16:00",
        defaultDurationMinutes: 30,
        blackoutWindows: [
          { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
        ],
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
      name: "ask-prefs",
      room: "main",
      text: "Remind me what my default meeting preferences are.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "prefs-surfaced",
      predicate: checkPrefsSurfaced,
    },
    judgeRubric({
      name: "scheduling-prefs-persistence-rubric",
      threshold: 0.5,
      description: `Seeded prefs: 09:30-16:00 working hours, 30-min default duration, 12:00-13:00 lunch blackout. Agent should echo at least one of these. Incorrect: agent says "I don't know your prefs" or asks the user.`,
    }),
  ],
});
