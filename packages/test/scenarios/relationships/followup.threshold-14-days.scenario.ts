/** Proves a per-contact 14-day cadence controls the overdue query. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectSuccessfulActionData } from "./_assertions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  lane: "pr-deterministic",
  id: "followup.threshold-14-days",
  title: "Follow-up threshold of 14 days",
  domain: "relationships",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["lifeops", "relationships", "follow-up", "cadence"],
  description:
    "Calls the canonical SCHEDULED_TASKS overdue query and verifies that durable per-contact cadence includes Dana but excludes Evan.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: 14-day follow-up threshold",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Dana Park",
      followupThresholdDays: 14,
      lastContactedAt: new Date(now - 15 * DAY_MS).toISOString(),
    },
    {
      type: "contact",
      name: "Evan Holt",
      followupThresholdDays: 14,
      lastContactedAt: new Date(now - 10 * DAY_MS).toISOString(),
    },
  ],

  turns: [
    {
      kind: "action",
      name: "check-14-day-threshold",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "Read contacts beyond their stored follow-up cadence.",
      options: {
        parameters: { action: "list_overdue_followups" },
      },
      responseIncludesAll: ["Dana Park", "14-day cadence"],
      responseExcludes: ["Evan Holt"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "followup-threshold-structured-result",
      predicate: (ctx) =>
        expectSuccessfulActionData({
          ctx,
          actionName: "SCHEDULED_TASKS",
          includes: ["list_overdue_followups", "Dana Park", "14"],
          excludes: ["Evan Holt"],
        }),
    },
  ],
});
