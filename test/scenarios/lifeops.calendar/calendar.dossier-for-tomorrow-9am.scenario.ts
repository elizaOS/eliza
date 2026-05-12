/**
 * Build a pre-meeting dossier for tomorrow's 9am.
 *
 * Failure mode guarded: agent fabricates context from training data; the
 * dossier must reference the seeded event title and attendee. If the email
 * inbox / notes are empty the agent should say so honestly, not invent
 * "key talking points".
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedCalendarCache } from "../_helpers/lifeops-seeds.ts";

function checkDossierAddressesSeededMeeting(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (!reply) return "empty reply";
  if (!reply.includes("budget review") && !reply.includes("hank")) {
    return `Dossier didn't reference the seeded "Budget review" with Hank. Reply: ${reply.slice(0, 300)}`;
  }
  // Negative check: no fabricated specific names not in seed.
  const fabricatedSignals = ["sarah", "marcus", "deal stage", "wire cutoff"];
  for (const f of fabricatedSignals) {
    if (reply.includes(f)) {
      return `Dossier fabricated content: "${f}"`;
    }
  }
  return undefined;
}

export default scenario({
  id: "calendar.dossier-for-tomorrow-9am",
  title: "Pre-meeting dossier references the seeded 9am event without fabrication",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "dossier", "no-fabrication"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar", "gmail"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Pre-Meeting Dossier",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-9am-meeting",
      apply: seedCalendarCache({
        events: [
          {
            id: "budget-review-9am",
            title: "Budget review",
            startOffsetMinutes: 24 * 60 + 9 * 60,
            durationMinutes: 60,
            attendees: ["hank@example.test"],
          },
        ],
      }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-dossier",
      room: "main",
      text: "Build me a pre-meeting dossier for tomorrow's 9am — who's it with, what's the context.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "dossier-grounded",
      predicate: checkDossierAddressesSeededMeeting,
    },
    judgeRubric({
      name: "calendar-dossier-rubric",
      threshold: 0.6,
      description: `Tomorrow 9am is "Budget review" with hank@example.test. Correct: dossier references the title and attendee. Incorrect: dossier fabricates a different meeting, invents prior emails not in the seed, or names people not present.`,
    }),
  ],
});
