/**
 * The user asks for a shareable scheduling link (Calendly-style). The
 * agent must either generate one or explain why it can't, with a concrete
 * actionable alternative (3 slots over email, etc.).
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkAgentHandledSchedulingLink(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "calendly",
    "link",
    "scheduling page",
    "self-schedule",
    "share",
    "instead",
    "alternative",
    "three slots",
    "three options",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't address the scheduling-link request. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "scheduling.calendly-link-generation",
  title: "Handles a scheduling-link request (generate or alternative)",
  domain: "lifeops.scheduling",
  tags: ["lifeops", "scheduling", "calendly"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Calendly Link",
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
      name: "ask-for-calendly-link",
      room: "main",
      text: "Send Hank a Calendly link to book any 30-min slot next week.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "scheduling-link-handled",
      predicate: checkAgentHandledSchedulingLink,
    },
    judgeRubric({
      name: "scheduling-calendly-rubric",
      threshold: 0.5,
      description: `User asked for a Calendly-style link. Correct: agent either creates one (if integration exists), or explains it can't and proposes a fallback (3 slots over email). Incorrect: agent says "done" without delivering anything or explaining.`,
    }),
  ],
});
