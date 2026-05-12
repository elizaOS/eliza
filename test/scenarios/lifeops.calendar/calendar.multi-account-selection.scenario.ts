/**
 * Multi-account selection — user has both a personal and a work calendar
 * connected. Asking to add an event without specifying triggers a
 * clarification.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

function checkAgentAsksWhichAccount(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const signals = [
    "which calendar",
    "personal or work",
    "work or personal",
    "which account",
    "default",
    "want me to add it to",
  ];
  if (!signals.some((s) => reply.includes(s))) {
    return `Agent didn't ask which account to use. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.multi-account-selection",
  title: "Two connected calendars triggers a clarification before write",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "multi-account", "clarification"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Multi-Account Selection",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-two-accounts",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
          email: "personal@example.test",
          grantId: "personal-grant-1",
        });
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
          email: "work@company.test",
          grantId: "work-grant-1",
        });
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ambiguous-add-event",
      room: "main",
      text: "Add a doctor's appointment Friday at 3pm.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-asked-which-account",
      predicate: checkAgentAsksWhichAccount,
    },
    judgeRubric({
      name: "calendar-multi-account-rubric",
      threshold: 0.6,
      description: `User has BOTH a personal Google calendar and a work Google calendar connected. Adding a "doctor's appointment" is ambiguous as to which calendar. Correct: agent asks which calendar (and may default to personal if it explains the assumption). Incorrect: agent silently writes to one without explaining or asking.`,
    }),
  ],
});
