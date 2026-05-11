/**
 * Multi-turn flow — agent proposes 3 slots, attendee counter-proposes a
 * different time, agent must reconcile (either accept the counter or push
 * back with another concrete option, not just say "ok let me check").
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkReconciliation(ctx: ScenarioContext): string | undefined {
  // The second user turn is the counter-proposal; the agent's reply on the
  // second turn must concretely accept or counter.
  const secondReply = String(ctx.turns?.[1]?.responseText ?? "").toLowerCase();
  if (!secondReply) return "agent gave no second-turn reply to counter-proposal";
  const decisionSignals = [
    "works",
    "confirmed",
    "accept",
    "booked",
    "scheduled",
    "instead",
    "alternative",
    "can't make",
    "cannot",
    "won't work",
    "wont work",
    "how about",
  ];
  if (!decisionSignals.some((s) => secondReply.includes(s))) {
    return `Agent didn't actually decide on the counter-proposal. Reply: ${secondReply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.attendee-counter-proposes",
  title: "Agent reconciles when the attendee counter-proposes a different time",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "negotiation"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Counter Proposal",
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
      name: "initial-proposal",
      room: "main",
      text: "Propose three 30-minute slots tomorrow for a quick call with Tomas.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
    {
      kind: "message",
      name: "counter-from-tomas",
      room: "main",
      text: "Tomas replied — none of those work, can we do 4pm tomorrow instead?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "agent-reconciled-counter",
      predicate: checkReconciliation,
    },
    judgeRubric({
      name: "scheduling-counter-proposal-rubric",
      threshold: 0.6,
      description: `After proposing slots, the agent received a counter-proposal of "4pm tomorrow". Correct: agent either accepts/books 4pm or explains a concrete conflict and proposes another time. Incorrect: agent says "let me check" without resolving.`,
    }),
  ],
});
