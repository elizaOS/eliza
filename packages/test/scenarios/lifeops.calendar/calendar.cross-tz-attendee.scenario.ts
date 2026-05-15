/**
 * Cross-timezone attendee proposal — Denver organizer with a Tokyo attendee.
 *
 * Failure mode guarded: the agent proposes times in the organizer's TZ only
 * and assumes the attendee will translate. With a 17h difference between
 * Denver (UTC-7 MDT) and Tokyo (UTC+9 JST), a "3pm-5pm slot" for Denver
 * lands at 6am-8am next-day Tokyo — almost certainly outside Tokyo waking
 * hours. The agent must explicitly respect BOTH TZ ranges.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkProposalNamesBothTimezones(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const denverSignals = ["denver", "mdt", "mst", "mountain", "utc-7", "utc-6"];
  const tokyoSignals = ["tokyo", "jst", "japan", "utc+9"];
  const hasDenver = denverSignals.some((s) => reply.includes(s));
  const hasTokyo = tokyoSignals.some((s) => reply.includes(s));
  if (!hasDenver || !hasTokyo) {
    return `Reply must name BOTH timezones (Denver/MDT and Tokyo/JST). Got: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.cross-tz-attendee",
  title: "Proposing times for a Denver-Tokyo meeting names both timezones",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "timezone", "scheduling"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-TZ Proposal",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs-denver",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "17:00",
        defaultDurationMinutes: 30,
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
      name: "propose-cross-tz",
      room: "main",
      text: "I'm in Denver. I need to set up a 30-minute call next week with Hana — she's in Tokyo. Propose three slots that work for both of us during normal working hours in each city.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "proposal-names-both-timezones",
      predicate: checkProposalNamesBothTimezones,
    },
    judgeRubric({
      name: "calendar-cross-tz-rubric",
      threshold: 0.6,
      description: `Denver–Tokyo scheduling has limited overlap because of the 17h offset. A correct proposal: names both timezones explicitly, picks slots that fall within reasonable working hours for BOTH parties (e.g. evenings Denver = mornings Tokyo, or vice versa), and lists the time in both TZ. An incorrect proposal: lists only Denver times, lists Tokyo times that land at 3am, or fails to label timezones.`,
    }),
  ],
});
